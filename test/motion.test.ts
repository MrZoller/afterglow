import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { blend, parts, rgbToHsv, sampleLoop } from '../shared/color';
import { frameCost, MOTION_BANDS, motionStepSeconds, renderLook, rotatePalette } from '../shared/looks';
import type { Look } from '../shared/types';
import { GoveeCloud } from '../server/govee/cloud';
import { startFakeGovee, type FakeGovee } from '../server/govee/fake';
import { Hub } from '../server/hub';
import { Ops } from '../server/ops';
import { Store } from '../server/store';

const RED = 0xff0000;
const GREEN = 0x00ff00;
const BLUE = 0x0000ff;
const palette = [RED, GREEN, BLUE];
const moving = (pattern: Look['pattern'], extra: Partial<Look> = {}) => ({ colors: palette, pattern, motion: { loopMinutes: 30 }, ...extra });

describe('colours that change over time', () => {
  it('keeps vivid colours vivid on the way, and cross-fades pale ones', () => {
    const mid = rgbToHsv(blend(RED, GREEN, 0.5));
    assert.ok(mid.s > 0.95 && mid.v > 0.95, 'red to green should pass through a bright yellow, not brown');
    assert.ok(Math.abs(mid.h - 60) < 2);

    const [r, g, b] = parts(blend(0xffb46b, 0xcfe3ff, 0.5)); // warm white to cool white
    assert.ok(g < r + 5 && g > b - 5, 'the midpoint of two whites should stay a white, without a green tint');
  });

  it('treats the palette as a loop', () => {
    assert.equal(sampleLoop(palette, 0), RED);
    assert.equal(sampleLoop(palette, 1 / 3), GREEN);
    assert.equal(sampleLoop(palette, 1), RED);
    assert.equal(sampleLoop(palette, -1 / 3), BLUE);
    assert.equal(sampleLoop(palette, 5 / 6), blend(BLUE, RED, 0.5));
    assert.deepEqual(rotatePalette(palette, 1 / 3), [GREEN, BLUE, RED]);
  });
});

describe('moving looks', () => {
  it('moves each pattern by rotating its palette', () => {
    assert.deepEqual(renderLook(moving('solid'), 4, 0, 1 / 3), [GREEN, GREEN, GREEN, GREEN]);
    // One per light: each light takes on its neighbour's colour, so colours travel between lights.
    assert.deepEqual(renderLook(moving('perLight'), 1, 0, 0), [RED]);
    assert.deepEqual(renderLook(moving('perLight'), 1, 0, 1 / 3), [GREEN]);
    assert.deepEqual(renderLook(moving('perLight'), 1, 2, 1 / 3), [RED]);
    assert.deepEqual(renderLook(moving('blocks'), 6, 0, 1 / 3), [GREEN, GREEN, BLUE, BLUE, RED, RED]);
    assert.deepEqual(renderLook(moving('alternate'), 4, 0, 2 / 3), [BLUE, RED, GREEN, BLUE]);
    // A painted design keeps its layout; each painted colour follows the palette.
    assert.deepEqual(renderLook(moving('custom', { segments: [RED, RED, BLUE, RED] }), 4, 0, 1 / 3), [GREEN, GREEN, RED, GREEN]);
  });

  it('keeps the number of colours per light steady, so each step costs the same', () => {
    for (const phase of [0.05, 0.37, 0.81]) {
      assert.equal(new Set(renderLook(moving('solid'), 15, 0, phase)).size, 1);
      assert.equal(new Set(renderLook(moving('blocks'), 15, 0, phase)).size, 3);
      assert.equal(new Set(renderLook(moving('gradient'), 15, 0, phase)).size, MOTION_BANDS);
    }
    assert.equal(frameCost(moving('perLight'), 15, 1), 1);
    assert.equal(frameCost(moving('blocks'), 15), 3);
    assert.equal(frameCost(moving('blocks'), 0), 1); // a light without segments shows one colour
  });

  it('leaves still looks alone whatever the phase', () => {
    const still = { colors: palette, pattern: 'gradient' as const };
    assert.deepEqual(renderLook(still, 15, 0, 0.5), renderLook(still, 15, 0, 0));
    const single = { colors: [RED], pattern: 'solid' as const, motion: { loopMinutes: 30 } };
    assert.deepEqual(renderLook(single, 3, 0, 0.5), [RED, RED, RED]);
  });

  it('paces steps to look gradual without overspending requests', () => {
    // 30-minute loop over 3 colours: 8 steps between neighbours is one every 75 seconds.
    assert.equal(motionStepSeconds(moving('solid'), [15, 15]), 75);
    // Three colours per light per step: held to 75 requests per light per hour.
    assert.equal(motionStepSeconds(moving('blocks'), [15]), 145);
    assert.ok((frameCost(moving('blocks'), 15) * 3600) / motionStepSeconds(moving('blocks'), [15]) <= 75);
    // A four-hour loop steps far less often; a very short one never steps faster than the allowance.
    assert.equal(motionStepSeconds({ ...moving('solid'), motion: { loopMinutes: 240 } }, [15]), 600);
    assert.equal(motionStepSeconds({ ...moving('solid'), motion: { loopMinutes: 2 } }, [15]), 50);
  });
});

describe('upgrading an existing install', () => {
  it('adds the new moving starter looks once, and respects deleting them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-upgrade-'));
    const older = { version: 1, looks: [{ id: 'starter-warm', name: 'Warm welcome', colors: [0xffb46b], pattern: 'solid', brightness: 70, createdAt: 1, updatedAt: 1 }] };
    fs.writeFileSync(path.join(dir, 'afterglow.json'), JSON.stringify(older));

    const store = new Store(dir);
    assert.deepEqual(store.data.looks.map((l) => l.id), ['starter-warm', 'starter-drift', 'starter-embers']);
    assert.deepEqual(store.data.looks[1].motion, { loopMinutes: 30 });
    assert.deepEqual(store.data.animations, []);

    store.data.looks = store.data.looks.filter((l) => l.id !== 'starter-drift');
    store.flush();
    assert.deepEqual(new Store(dir).data.looks.map((l) => l.id), ['starter-warm', 'starter-embers']);
  });
});

describe('running a moving look', () => {
  let fake: FakeGovee;
  let hub: Hub;
  let store: Store;
  let ops: Ops;
  let lookId: string;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-motion-'));

  before(async () => {
    fake = await startFakeGovee({ latencyMs: 1 });
    store = new Store(dir);
    hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url, onRequest: () => store.countRequest() }), store);
    ops = new Ops(store, hub, () => undefined);
    await hub.discover();
    lookId = ops.saveLook({ name: 'Drift', colors: palette, pattern: 'perLight', brightness: null, motion: { loopMinutes: 30 } }).id;
  });
  after(() => fake.close());

  const ids = () => hub.list().slice(0, 3).map((d) => d.id);
  const light = (i: number) => hub.list()[i];
  const sent = (id: string) => fake.controls.filter((c) => c.device === id).map((c) => [c.capability.instance, c.capability.value]);
  const reset = () => (fake.controls.length = 0);
  const started = () => store.data.animations[0].startedAt;

  it('shows the first frame and starts moving', async () => {
    reset();
    await (await hub.apply(ids(), { type: 'look', lookId }, 'schedule')).done;
    assert.deepEqual(sent(ids()[0]), [['powerSwitch', 1], ['colorRgb', RED]]);
    assert.deepEqual(sent(ids()[1]), [['powerSwitch', 1], ['colorRgb', GREEN]]);
    assert.deepEqual(hub.list().slice(0, 4).map((d) => d.moving), [true, true, true, false]);
    assert.equal(store.data.animations.length, 1);
    assert.equal(store.data.animations[0].stepSeconds, 75);
  });

  it('sends each light its next colour when a step is due, and nothing before', async () => {
    reset();
    await hub.animator.tick(started() + 74_000);
    assert.equal(fake.controls.length, 0);

    await hub.animator.tick(started() + 75_000);
    const expected = blend(RED, GREEN, 75 / 600); // a third of the 30-minute loop is 600 seconds
    assert.deepEqual(sent(ids()[0]), [['colorRgb', expected]]);
    assert.deepEqual(light(0).state.appearance, { mode: 'color', rgb: expected });
    assert.equal(light(0).state.lookId, lookId, 'the light is still showing the look');
    assert.equal(fake.controls.length, 3, 'one request per light per step');

    // A third of the way round, every light has become its neighbour's colour.
    reset();
    await hub.animator.tick(started() + 600_000);
    assert.deepEqual(ids().map((id) => sent(id)[0][1]), [GREEN, BLUE, RED]);
  });

  it('stops on a light when something else is applied to it, and carries on elsewhere', async () => {
    await (await hub.apply([ids()[0]], { type: 'color', rgb: 0x123456 }, 'app')).done;
    assert.deepEqual(hub.list().slice(0, 3).map((d) => d.moving), [false, true, true]);
    reset();
    await hub.animator.tick(started() + 900_000);
    assert.equal(sent(ids()[0]).length, 0);
    assert.equal(sent(ids()[1]).length, 1);

    // Brightness does not interrupt it; holding and switching off do.
    await (await hub.apply([ids()[1]], { type: 'brightness', value: 30 }, 'app')).done;
    assert.equal(light(1).moving, true);
    const held = await hub.apply(ids(), { type: 'still' }, 'app');
    assert.deepEqual(held.summary.skipped.map((s) => s.reason), ['not moving']);
    assert.deepEqual(hub.list().slice(0, 3).map((d) => d.moving), [false, false, false]);
    assert.equal(store.data.animations.length, 0);

    await (await hub.apply(ids(), { type: 'look', lookId }, 'app')).done;
    assert.equal(light(2).moving, true);
    await (await hub.apply(['all'], { type: 'power', on: false }, 'app')).done;
    assert.equal(hub.list().some((d) => d.moving), false);
  });

  it('carries on after a restart', async () => {
    await (await hub.apply(ids(), { type: 'look', lookId }, 'app')).done;
    store.flush();
    const store2 = new Store(dir);
    const hub2 = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), store2);
    assert.deepEqual(hub2.list().slice(0, 3).map((d) => d.moving), [true, true, true]);
    reset();
    await hub2.animator.tick(store2.data.animations[0].startedAt + 600_000);
    assert.deepEqual(ids().map((id) => sent(id)[0][1]), [GREEN, BLUE, RED]);
  });

  it('pauses rather than run the account out of requests', async () => {
    reset();
    const before = store.data.usage.count;
    store.data.usage.count = 9_000;
    await hub.animator.tick(started() + 1_200_000);
    await hub.animator.tick(started() + 1_300_000);
    assert.equal(fake.controls.length, 0);
    assert.equal(store.data.activity.filter((a) => /paused for today/.test(a.text)).length, 1, 'said once, not at every step');
    store.data.usage.count = before;
  });

  it('gives up on a light that keeps failing', async () => {
    const gone = ids()[2];
    fake.lights.splice(fake.lights.findIndex((l) => l.device === gone), 1);
    for (const minutes of [25, 27, 29]) await hub.animator.tick(started() + minutes * 60_000);
    assert.deepEqual(hub.list().slice(0, 3).map((d) => d.moving), [true, true, false]);
    assert.ok(store.data.activity.some((a) => /Stopped moving "Drift"/.test(a.text)));
  });

  it('moves a look tried from the editor, and treats a one-colour look as still', async () => {
    await (await hub.apply([ids()[0]], { type: 'palette', colors: palette, pattern: 'solid', brightness: null, motion: { loopMinutes: 20 } }, 'app')).done;
    assert.equal(light(0).moving, true);
    await (await hub.apply([ids()[0]], { type: 'palette', colors: [RED], pattern: 'solid', brightness: null, motion: { loopMinutes: 20 } }, 'app')).done;
    assert.equal(light(0).moving, false);
  });
});
