import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { placeColors, placedCost, placeLights, renderLook, renderPlaced } from '../shared/looks';
import { GoveeCloud } from '../server/govee/cloud';
import { startFakeGovee, type FakeGovee } from '../server/govee/fake';
import { Hub } from '../server/hub';
import { Ops } from '../server/ops';
import { Store } from '../server/store';

const RED = 0xff0000;
const GREEN = 0x00ff00;
const BLUE = 0x0000ff;
const gradient = { colors: [RED, GREEN, BLUE], pattern: 'gradient' as const };

const lights = [
  { id: 'a', segments: 15, reversed: false },
  { id: 'b', segments: 15, reversed: false },
  { id: 'c', segments: 12, reversed: false },
];

describe('lights joined end to end', () => {
  it('places a joined pair as one long light, and other lights after it', () => {
    const placed = placeLights(lights, [{ deviceIds: ['a', 'b'], joined: true }]);
    assert.deepEqual(placed.get('a'), { segments: 15, index: 0, offset: 0, total: 30, reversed: false });
    assert.deepEqual(placed.get('b'), { segments: 15, index: 0, offset: 15, total: 30, reversed: false });
    assert.deepEqual(placed.get('c'), { segments: 12, index: 1, reversed: false });
  });

  it('follows the order of the zone, not the order lights happen to be listed in', () => {
    const placed = placeLights(lights, [{ deviceIds: ['b', 'a'], joined: true }]);
    assert.equal(placed.get('b')!.offset, 0);
    assert.equal(placed.get('a')!.offset, 15);
  });

  it('treats a light on its own when its partner is not included, or the zone is not joined', () => {
    assert.deepEqual(placeLights([lights[0], lights[2]], [{ deviceIds: ['a', 'b'], joined: true }]).get('a'), { segments: 15, index: 0, reversed: false });
    assert.equal(placeLights(lights, [{ deviceIds: ['a', 'b'] }]).get('b')!.total, undefined);
  });

  it('ignores lights that no longer exist, and keeps a light in only one run', () => {
    const exists = (id: string) => id !== 'gone';
    assert.equal(placeLights(lights, [{ deviceIds: ['a', 'gone', 'b'], joined: true }], exists).get('b')!.offset, 15);
    const twice = placeLights(lights, [
      { deviceIds: ['a', 'b'], joined: true },
      { deviceIds: ['b', 'c'], joined: true },
    ]);
    assert.equal(twice.get('b')!.total, 30);
    assert.equal(twice.get('c')!.total, undefined);
  });

  it('runs a design across the pair without a break', () => {
    const placed = placeLights(lights, [{ deviceIds: ['a', 'b'], joined: true }]);
    const a = renderPlaced(gradient, placed.get('a')!);
    const b = renderPlaced(gradient, placed.get('b')!);
    assert.deepEqual([...a, ...b], renderLook(gradient, 30));
    assert.equal(a[0], RED);
    assert.equal(b[14], BLUE);
    // Eight bands over the whole run means four per rope: half the requests of a rope on its own.
    assert.equal(placedCost(gradient, placed.get('a')!), 4);
    assert.equal(placedCost(gradient, { segments: 15, index: 0 }), 8);
  });

  it('flips a light that is mounted backwards', () => {
    const forwards = renderPlaced(gradient, { segments: 15, index: 0, offset: 15, total: 30 });
    const backwards = renderPlaced(gradient, { segments: 15, index: 0, offset: 15, total: 30, reversed: true });
    assert.deepEqual(backwards, [...forwards].reverse());
    assert.deepEqual(renderPlaced(gradient, { segments: 4, index: 0, reversed: true }), [...renderLook(gradient, 4)].reverse());
  });

  it('gives a joined pair one colour between them for one-per-light looks', () => {
    const placed = placeLights(lights, [{ deviceIds: ['a', 'b'], joined: true }]);
    const perLight = { colors: [RED, GREEN, BLUE], pattern: 'perLight' as const };
    assert.equal(renderPlaced(perLight, placed.get('a')!)[0], RED);
    assert.equal(renderPlaced(perLight, placed.get('b')!)[0], RED);
    assert.equal(renderPlaced(perLight, placed.get('c')!)[0], GREEN);
  });

  it('splits a painted design across the pair', () => {
    const painted = [...Array(15).fill(RED), ...Array(15).fill(BLUE)];
    const placed = placeLights(lights, [{ deviceIds: ['a', 'b'], joined: true }]);
    assert.deepEqual(new Set(placeColors(painted, placed.get('a')!)), new Set([RED]));
    assert.deepEqual(new Set(placeColors(painted, placed.get('b')!)), new Set([BLUE]));
    // Six cells painted across thirty segments: stretched first, then split.
    assert.deepEqual(placeColors([RED, RED, RED, GREEN, GREEN, BLUE], placed.get('b')!).slice(0, 5), Array(5).fill(GREEN));
  });
});

describe('joined lights in the hub', () => {
  let fake: FakeGovee;
  let hub: Hub;
  let store: Store;
  let ops: Ops;
  let zone: string;

  before(async () => {
    fake = await startFakeGovee({ latencyMs: 1 });
    store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-joined-')));
    hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), store);
    ops = new Ops(store, hub, () => undefined);
    await hub.discover();
    zone = ops.saveGroup({ name: 'Right walkway', deviceIds: [rope(0).id, rope(1).id], joined: true }).id;
  });
  after(() => fake.close());

  const rope = (i: number) => hub.list().filter((d) => d.sku === 'H61A9')[i];
  const shown = (i: number) => {
    const a = rope(i).state.appearance;
    return a.mode === 'segments' ? a.colors : a.mode === 'color' ? Array(15).fill(a.rgb) : [];
  };
  const segmentsSent = (id: string) => fake.controls.filter((c) => c.device === id && c.capability.instance === 'segmentedColorRgb').map((c) => c.capability.value as { segment: number[]; rgb: number });

  it('spreads a look across the pair when the zone is the target', async () => {
    fake.controls.length = 0;
    const look = ops.saveLook({ name: 'Sweep', ...gradient, brightness: null });
    await (await hub.apply([`group:${zone}`], { type: 'look', lookId: look.id }, 'app')).done;
    assert.deepEqual([...shown(0), ...shown(1)], renderLook(gradient, 30));
    // Each rope received only its own four bands.
    assert.equal(segmentsSent(rope(0).id).length, 4);
    assert.equal(segmentsSent(rope(1).id).length, 4);
    assert.deepEqual(segmentsSent(rope(0).id)[0], { segment: [0, 1, 2, 3], rgb: RED });
  });

  it('does the same when the pair is part of a bigger target, and not for one rope alone', async () => {
    await (await hub.apply(['all'], { type: 'palette', ...gradient, brightness: null }, 'app')).done;
    assert.deepEqual([...shown(0), ...shown(1)], renderLook(gradient, 30));
    assert.deepEqual(shown(2), renderLook(gradient, 15), 'a rope that is not joined shows the whole design');

    await (await hub.apply([rope(0).id], { type: 'palette', ...gradient, brightness: null }, 'app')).done;
    assert.deepEqual(shown(0), renderLook(gradient, 15));
  });

  it('respects a rope marked as reversed', async () => {
    hub.update(rope(1).id, { reversed: true });
    assert.equal(rope(1).reversed, true);
    await (await hub.apply([`group:${zone}`], { type: 'palette', ...gradient, brightness: null }, 'app')).done;
    assert.deepEqual(shown(1), renderLook(gradient, 30).slice(15).reverse());
    hub.update(rope(1).id, { reversed: false });
  });

  it('paints across the pair', async () => {
    const painted = [...Array(10).fill(RED), ...Array(10).fill(GREEN), ...Array(10).fill(BLUE)];
    await (await hub.apply([`group:${zone}`], { type: 'segments', colors: painted }, 'app')).done;
    assert.deepEqual(shown(0), [...Array(10).fill(RED), ...Array(5).fill(GREEN)]);
    assert.deepEqual(shown(1), [...Array(5).fill(GREEN), ...Array(10).fill(BLUE)]);
  });

  it('moves a look along the whole run', async () => {
    const blocks = { colors: [RED, GREEN, BLUE], pattern: 'blocks' as const, motion: { loopMinutes: 30 } };
    await (await hub.apply([`group:${zone}`], { type: 'palette', ...blocks, brightness: null }, 'app')).done;
    const animation = store.data.animations[0];
    assert.deepEqual(animation.lights.map((l) => [l.index, l.offset, l.total]), [
      [0, 0, 30],
      [0, 15, 30],
    ]);
    // A third of the way round, every band has become the next colour, still as one design.
    await hub.animator.tick(animation.startedAt + 600_000);
    assert.deepEqual([...shown(0), ...shown(1)], renderLook(blocks, 30, 0, 1 / 3));
    await (await hub.apply([`group:${zone}`], { type: 'still' }, 'app')).done;
  });

  it('keeps a light in one joined zone only', () => {
    assert.throws(() => ops.saveGroup({ name: 'Other', deviceIds: [rope(1).id, rope(2).id], joined: true }), /already joined in “Right walkway”/);
    assert.throws(() => ops.saveGroup({ name: 'Solo', deviceIds: [rope(2).id], joined: true }), /at least two lights/);
    // The same lights may still share an ordinary zone, and the zone itself can be edited.
    assert.ok(ops.saveGroup({ name: 'Front yard', deviceIds: [rope(0).id, rope(1).id, rope(2).id] }));
    assert.ok(ops.saveGroup({ name: 'Right walkway', deviceIds: [rope(1).id, rope(0).id], joined: true }, zone));
    assert.equal(store.data.groups.find((g) => g.id === zone)!.deviceIds[0], rope(1).id);
  });

  it('lists lights in the order they were arranged, and hands out colours in that order', async () => {
    const ids = hub.list().map((d) => d.id);
    const rearranged = [ids[7], ...ids.slice(0, 7)];
    hub.setOrder(rearranged);
    assert.deepEqual(hub.list().map((d) => d.id), rearranged);
    const perLight = { colors: [RED, GREEN, BLUE], pattern: 'perLight' as const };
    await (await hub.apply(['all'], { type: 'palette', ...perLight, brightness: null }, 'app')).done;
    assert.deepEqual(hub.list()[0].state.appearance, { mode: 'color', rgb: RED });
    // The joined pair comes next and shares the second colour.
    assert.deepEqual(rope(0).state.appearance, { mode: 'color', rgb: GREEN });
    assert.deepEqual(rope(1).state.appearance, { mode: 'color', rgb: GREEN });
  });
});
