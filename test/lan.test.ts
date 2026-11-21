import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GoveeCloud } from '../server/govee/cloud';
import { startFakeGovee, type FakeGovee } from '../server/govee/fake';
import { startFakeLan, type FakeLan } from '../server/govee/fake-lan';
import { GoveeLan } from '../server/govee/lan';
import { Hub } from '../server/hub';
import { Ops } from '../server/ops';
import { Store } from '../server/store';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-lan-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Four rope lights answer locally; the four garden lights can only be reached through the cloud. */
describe('local network control', () => {
  let cloudSide: FakeGovee;
  let lanSide: FakeLan;
  let lan: GoveeLan;
  let hub: Hub;
  let store: Store;
  let ops: Ops;

  before(async () => {
    cloudSide = await startFakeGovee({ latencyMs: 1 });
    lanSide = await startFakeLan(cloudSide.lights.filter((l) => l.sku === 'H61A9'));
    lan = new GoveeLan({ scanAddress: '127.0.0.1', scanPort: lanSide.scanPort, listenPort: 0, statusTimeoutMs: 150 });
    await lan.start();
    for (let i = 0; i < 40 && lan.reachable().length < 4; i++) await wait(10);
    store = new Store(tmp());
    hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: cloudSide.url, onRequest: () => store.countRequest() }), store, lan);
    hub.confirmDelayMs = 5;
    ops = new Ops(store, hub, () => undefined);
    await hub.discover();
    await hub.refresh();
  });
  after(async () => {
    lan.stop();
    await lanSide.close();
    await cloudSide.close();
  });

  const rope = (i = 0) => hub.list().filter((d) => d.sku === 'H61A9')[i];
  const garden = (i = 0) => hub.list().filter((d) => d.sku === 'H7086')[i];
  const local = (id: string) => lanSide.received.filter((r) => r.device === id).map((r) => [r.cmd, r.data]);
  const viaCloud = (id: string) => cloudSide.controls.filter((c) => c.device === id).map((c) => [c.capability.instance, c.capability.value]);
  const reset = () => {
    lanSide.received.length = 0;
    cloudSide.controls.length = 0;
  };
  const requests = () => store.requestsToday();

  it('finds the lights that answer locally and reads their state from them', async () => {
    assert.equal(lan.error, null);
    assert.deepEqual(hub.list().map((d) => d.local), [true, true, true, true, false, false, false, false]);
    assert.deepEqual(await lan.status(rope().id), { online: true, power: true, brightness: 80, rgb: 0xff8a1f, kelvin: null });
    assert.equal(await lan.status(garden().id), null);
  });

  it('sends power, brightness, colour and white locally, in the documented format, with no cloud requests', async () => {
    reset();
    const id = rope().id;
    const before = requests();
    for (const action of [
      { type: 'power', on: false },
      { type: 'power', on: true },
      { type: 'brightness', value: 42 },
      { type: 'color', rgb: 0x10a0f0 },
      { type: 'colorTemp', kelvin: 2700 },
    ] as const) {
      const { failed } = await (await hub.apply([id], action, 'app')).done;
      assert.deepEqual(failed, []);
    }
    assert.deepEqual(local(id), [
      ['turn', { value: 0 }],
      ['turn', { value: 1 }],
      ['brightness', { value: 42 }],
      ['colorwc', { color: { r: 16, g: 160, b: 240 }, colorTemInKelvin: 0 }],
      ['colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 2700 }],
    ]);
    assert.deepEqual(viaCloud(id), []);
    assert.equal(requests(), before, 'no cloud requests should have been counted');
    // Both simulators share state, so the cloud side sees what was done locally.
    assert.equal(cloudSide.lights.find((l) => l.device === id)!.brightness, 42);
    assert.equal(cloudSide.lights.find((l) => l.device === id)!.colorTemperatureK, 2700);
  });

  it('still uses the cloud for lights that are not on the local network', async () => {
    reset();
    const id = garden().id;
    await (await hub.apply([id], { type: 'power', on: false }, 'app')).done;
    assert.deepEqual(viaCloud(id), [['powerSwitch', 0]]);
    assert.equal(lanSide.received.length, 0);
  });

  it('splits a multi-colour look: power and brightness locally, segment colours through the cloud', async () => {
    reset();
    const id = rope(1).id;
    const look = ops.saveLook({ name: 'Bands', colors: [0xff0000, 0x00ff00, 0x0000ff], pattern: 'blocks', brightness: 55 });
    await (await hub.apply([id], { type: 'look', lookId: look.id }, 'schedule')).done;
    assert.deepEqual(local(id), [
      ['turn', { value: 1 }],
      ['brightness', { value: 55 }],
    ]);
    assert.deepEqual(viaCloud(id).map(([instance]) => instance), ['segmentedColorRgb', 'segmentedColorRgb', 'segmentedColorRgb']);
  });

  it('applies Govee scenes through the cloud, switching the light on locally first', async () => {
    reset();
    const id = rope(2).id;
    await (await hub.apply([id], { type: 'scene', scene: { kind: 'light', name: 'Aurora' } }, 'schedule')).done;
    assert.deepEqual(local(id), [['turn', { value: 1 }]]);
    assert.deepEqual(viaCloud(id).map(([instance]) => instance), ['lightScene']);
  });

  it('falls back to the cloud when a light stops answering, and returns to local when it is back', async () => {
    reset();
    const id = rope(3).id;
    lanSide.mute(id);
    const { failed } = await (await hub.apply([id], { type: 'color', rgb: 0xabcdef }, 'app')).done;
    assert.deepEqual(failed, []);
    assert.deepEqual(viaCloud(id).at(-1), ['colorRgb', 0xabcdef]);
    assert.equal(rope(3).local, false, 'a silent light is left to the cloud');

    lanSide.unmute(id);
    await lan.scan();
    for (let i = 0; i < 40 && !rope(3).local; i++) await wait(10);
    assert.equal(rope(3).local, true);
    reset();
    await (await hub.apply([id], { type: 'brightness', value: 20 }, 'app')).done;
    assert.deepEqual(local(id), [['brightness', { value: 20 }]]);
    assert.deepEqual(viaCloud(id), []);
  });

  it('notices changes made outside the app by asking the lights, without spending requests', async () => {
    const id = rope().id;
    await (await hub.apply([id], { type: 'color', rgb: 0x111111 }, 'app')).done;
    const light = cloudSide.lights.find((l) => l.device === id)!;
    const refreshLocal = () => (hub as unknown as { refreshLocal(): Promise<void> }).refreshLocal();
    // Skip the few seconds in which the app trusts its own last change over what it reads back.
    rope().state.updatedAt = 0;
    await refreshLocal(); // records what the light reports as the baseline

    const before = requests();
    light.brightness = 33; // as if changed in the Govee app
    light.colorRgb = 0x00ff00;
    light.colorTemperatureK = 0;
    await refreshLocal();
    assert.equal(rope().state.brightness, 33);
    assert.deepEqual(rope().state.appearance, { mode: 'color', rgb: 0x00ff00 });
    assert.equal(requests(), before);

    light.power = 0;
    rope().state.updatedAt = 0;
    await hub.refresh([id]);
    assert.equal(rope().state.power, false);
    assert.equal(requests(), before, 'a full refresh also asks the light rather than the cloud');
  });

  it('moves single-colour looks in small steps over the local network, even when cloud requests are nearly used up', async () => {
    const ids = [rope(0).id, rope(1).id, garden(0).id];
    const look = ops.saveLook({ name: 'Drift', colors: [0xff0000, 0x00ff00, 0x0000ff], pattern: 'perLight', brightness: null, motion: { loopMinutes: 30 } });
    await (await hub.apply(ids, { type: 'look', lookId: look.id }, 'app')).done;
    const animation = store.data.animations[0];
    // Ropes step every 10 seconds locally; the garden light steps every 75 seconds through the cloud.
    assert.deepEqual(animation.lights.map((l) => (l.nextAt - animation.startedAt) / 1000), [10, 10, 75]);

    reset();
    const usage = store.data.usage.count;
    store.data.usage.count = 9_500; // over the level at which cloud animations pause
    await hub.animator.tick(animation.startedAt + 10_000);
    assert.deepEqual(local(ids[0]).map(([cmd]) => cmd), ['colorwc']);
    assert.deepEqual(local(ids[1]).map(([cmd]) => cmd), ['colorwc']);
    assert.equal(cloudSide.controls.length, 0);

    await hub.animator.tick(animation.startedAt + 75_000);
    assert.equal(viaCloud(ids[2]).length, 0, 'the cloud light waits while requests are nearly used up');
    assert.equal(local(ids[0]).length, 2, 'the local lights keep moving');
    store.data.usage.count = usage;

    await hub.animator.tick(animation.startedAt + 150_000);
    assert.deepEqual(viaCloud(ids[2]).map(([instance]) => instance), ['colorRgb']);
    await (await hub.apply(['all'], { type: 'power', on: false }, 'app')).done;
  });
});

describe('when local control cannot start', () => {
  it('carries on through the cloud and says why', async () => {
    const blocker = dgram.createSocket('udp4');
    const port = await new Promise<number>((resolve) => blocker.bind(0, () => resolve((blocker.address() as AddressInfo).port)));
    const cloudSide = await startFakeGovee({ latencyMs: 1 });
    try {
      const lan = new GoveeLan({ scanAddress: '127.0.0.1', listenPort: port });
      await lan.start();
      assert.match(lan.error ?? '', /in use by another app/);
      const hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: cloudSide.url }), new Store(tmp()), lan);
      await hub.discover();
      assert.equal(hub.list().some((d) => d.local), false);
      const id = hub.list()[0].id;
      await (await hub.apply([id], { type: 'power', on: false }, 'app')).done;
      assert.equal(cloudSide.controls.length, 1);
    } finally {
      blocker.close();
      await cloudSide.close();
    }
  });
});

describe('finding lights after starting', () => {
  it('looks again within seconds when the first look gets no answer, rather than waiting a minute', async () => {
    const cloudSide = await startFakeGovee({ latencyMs: 1 });
    const lanSide = await startFakeLan(cloudSide.lights.slice(0, 2), { missedScans: 1 });
    // The regular scan is a minute away; only the early ones can find the lights in this test.
    const lan = new GoveeLan({ scanAddress: '127.0.0.1', scanPort: lanSide.scanPort, listenPort: 0, earlyScansMs: [40, 120] });
    try {
      let changes = 0;
      lan.on('change', () => changes++);
      await lan.start();
      await wait(20);
      assert.deepEqual(lan.reachable(), [], 'the first look found nothing');
      await wait(100);
      assert.equal(lan.reachable().length, 2);
      assert.equal(changes, 2, 'and the app is told, so the lights show as reached locally at once');
    } finally {
      lan.stop();
      await lanSide.close();
      await cloudSide.close();
    }
  });
});
