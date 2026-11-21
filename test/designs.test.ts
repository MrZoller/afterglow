import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { renderPlaced } from '../shared/looks';
import { Backups } from '../server/backup';
import { GoveeCloud } from '../server/govee/cloud';
import { startFakeGovee } from '../server/govee/fake';
import { startFakeLan } from '../server/govee/fake-lan';
import { frame, GoveeLan, MAX_FRAMES, segmentFrame } from '../server/govee/lan';
import { Hub } from '../server/hub';
import { Ops } from '../server/ops';
import { Store } from '../server/store';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-designs-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (bytes: Buffer) => bytes.toString('hex').replace(/(..)/g, '$1 ').trim();

describe('the frames a design is sent in', () => {
  it('are 20 bytes: data, zero padding, and the XOR of the rest', () => {
    assert.equal(hex(frame([0x33, 0x01, 0x01])), '33 01 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 33');
    // The value govee-lan-bridge's own tests expect for one of its commands.
    assert.equal(hex(frame([0x33, 0x30, 0x03, 0x00])), '33 30 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00');
  });

  it('put the colour at bytes 4 to 6 and a mask of segments from byte 12', () => {
    // govee-local-api sends exactly this for its first segment: mask 01 00.
    assert.equal(hex(segmentFrame(0xff0000, [0], 15)), '33 05 15 01 ff 00 00 00 00 00 00 00 01 00 00 00 00 00 00 dc');
    // Its fifteenth segment is 00 40, and its ninth 00 01 (also the second mask byte in govee-lan-bridge's tests).
    assert.equal(hex(segmentFrame(0x102030, [14], 15)).slice(36, 41), '00 40');
    assert.equal(hex(segmentFrame(0x102030, [8], 15)).slice(36, 41), '00 01');
    // A seventeenth segment needs a third mask byte.
    assert.equal(segmentFrame(0x102030, [16], 20)[14], 0x01);
  });

  it('address several segments at once, and ignore ones the light does not have', () => {
    const bytes = segmentFrame(0x19ffd6, [0, 1, 2, 8, 99, -1], 15);
    assert.deepEqual([...bytes.subarray(4, 7)], [0x19, 0xff, 0xd6]);
    assert.deepEqual([...bytes.subarray(7, 12)], [0, 0, 0, 0, 0]);
    assert.deepEqual([...bytes.subarray(12, 14)], [0b0000_0111, 0b0000_0001]);
    assert.equal(bytes[19], bytes.subarray(0, 19).reduce((x, b) => x ^ b, 0));
  });
});

/** Four ropes that answer locally and take designs that way, four garden lights that only the cloud reaches. */
async function rig(opts: { busyMs?: number; minGapMs?: number } = {}) {
  const cloudSide = await startFakeGovee({ latencyMs: 1 });
  const lanSide = await startFakeLan(cloudSide.lights.filter((l) => l.sku === 'H61A9'), { busyMs: opts.busyMs });
  const lan = new GoveeLan({ scanAddress: '127.0.0.1', scanPort: lanSide.scanPort, listenPort: 0, statusTimeoutMs: 150, minGapMs: opts.minGapMs ?? 5 });
  await lan.start();
  for (let i = 0; i < 40 && lan.reachable().length < 4; i++) await wait(10);
  const store = new Store(tmp());
  const hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: cloudSide.url, onRequest: () => store.countRequest() }), store, lan);
  hub.confirmDelayMs = 5;
  const ops = new Ops(store, hub, () => undefined);
  await hub.discover();
  await hub.refresh();
  const light = (name: string) => hub.list().find((d) => d.goveeName === name)!;
  const sim = (name: string) => cloudSide.lights.find((l) => l.deviceName === name)!;
  return {
    cloudSide,
    lanSide,
    lan,
    store,
    hub,
    ops,
    light,
    sim,
    look: (id: string) => store.data.looks.find((l) => l.id === id)!,
    /** Local messages a light received, as [command, how many frames]. */
    local: (name: string) => lanSide.received.filter((r) => r.device === sim(name).device).map((r) => (r.cmd === 'ptReal' ? ['ptReal', r.data.command.length] : [r.cmd])),
    viaCloud: (name: string) => cloudSide.controls.filter((c) => c.device === sim(name).device).map((c) => c.capability.instance),
    reset: () => {
      lanSide.received.length = 0;
      cloudSide.controls.length = 0;
    },
    close: async () => {
      lan.stop();
      await lanSide.close();
      await cloudSide.close();
    },
  };
}

describe('multi-colour designs over the local network', () => {
  it('still go through the cloud until the model is switched on', async () => {
    const r = await rig();
    try {
      assert.equal(r.light('Patio rope').local, true);
      assert.equal(r.light('Patio rope').localDesigns, false);
      await (await r.hub.apply([r.light('Patio rope').id], { type: 'look', lookId: 'starter-ocean' }, 'app')).done;
      assert.equal(r.local('Patio rope').some(([cmd]) => cmd === 'ptReal'), false);
      assert.ok(r.viaCloud('Patio rope').filter((i) => i === 'segmentedColorRgb').length >= 3);
    } finally {
      await r.close();
    }
  });

  it('are sent in one message, using no cloud requests, once it is', async () => {
    const r = await rig();
    try {
      r.ops.updateSettings({ localDesigns: ['H61A9'] });
      assert.deepEqual([r.light('Patio rope').localDesigns, r.light('Front path lights').localDesigns], [true, false]);
      const rope = r.light('Patio rope');
      const garden = r.light('Front path lights');
      const requests = r.store.requestsToday();
      r.reset();

      await (await r.hub.apply([rope.id, garden.id], { type: 'look', lookId: 'starter-ocean' }, 'app')).done;

      const expected = renderPlaced(r.look('starter-ocean'), { segments: 15, index: 0 });
      assert.deepEqual(r.sim('Patio rope').segmentColors, expected, 'the rope shows the design');
      assert.deepEqual(r.light('Patio rope').state.appearance, { mode: 'segments', colors: expected });
      assert.deepEqual(r.viaCloud('Patio rope'), [], 'nothing for the rope went through the cloud');
      const messages = r.local('Patio rope').filter(([cmd]) => cmd === 'ptReal');
      assert.equal(messages.length, 1);
      assert.equal(messages[0][1], new Set(expected).size, 'one frame per colour');
      // The garden light is not on the local network, so its colours are cloud requests as before.
      const gardenRequests = r.viaCloud('Front path lights').length;
      assert.ok(gardenRequests >= 3);
      assert.equal(r.store.requestsToday() - requests, gardenRequests);
      assert.equal(r.sim('Front path lights').segmentColors.length, 12);
      assert.deepEqual(r.sim('Front path lights').segmentColors, renderPlaced(r.look('starter-ocean'), { segments: 12, index: 1 }));
    } finally {
      await r.close();
    }
  });

  it('splits a design with many colours into messages of twelve frames', async () => {
    const r = await rig();
    try {
      r.ops.updateSettings({ localDesigns: ['H61A9'] });
      const colors = Array.from({ length: 15 }, (_, i) => 0x100000 + i * 0x001122);
      r.reset();
      await (await r.hub.apply([r.light('Patio rope').id], { type: 'segments', colors }, 'app')).done;
      assert.deepEqual(r.local('Patio rope').filter(([cmd]) => cmd === 'ptReal'), [['ptReal', MAX_FRAMES], ['ptReal', 3]]);
      assert.deepEqual(r.sim('Patio rope').segmentColors, colors);
      assert.deepEqual(r.viaCloud('Patio rope'), []);
    } finally {
      await r.close();
    }
  });

  it('paints each joined light with its own share', async () => {
    const r = await rig();
    try {
      r.ops.updateSettings({ localDesigns: ['H61A9'] });
      const [first, second] = [r.light('Front fence rope').id, r.light('Patio rope').id];
      const zone = r.ops.saveGroup({ name: 'Walkway', deviceIds: [first, second], joined: true });
      r.reset();
      await (await r.hub.apply([`group:${zone.id}`], { type: 'look', lookId: 'starter-sunset' }, 'app')).done;
      const look = r.look('starter-sunset');
      assert.deepEqual(r.sim('Front fence rope').segmentColors, renderPlaced(look, { segments: 15, index: 0, offset: 0, total: 30 }));
      assert.deepEqual(r.sim('Patio rope').segmentColors, renderPlaced(look, { segments: 15, index: 0, offset: 15, total: 30 }));
      assert.equal(r.cloudSide.controls.length, 0);
    } finally {
      await r.close();
    }
  });

  it('falls back to the cloud for a light that has stopped answering locally', async () => {
    const r = await rig();
    try {
      r.ops.updateSettings({ localDesigns: ['H61A9'] });
      const rope = r.light('Patio rope');
      await (await r.hub.apply([rope.id], { type: 'power', on: true }, 'app')).done;
      r.lanSide.mute(r.sim('Patio rope').device);
      r.reset();
      const result = await r.hub.apply([rope.id], { type: 'look', lookId: 'starter-ocean' }, 'app');
      assert.deepEqual((await result.done).failed, []);
      assert.deepEqual(r.sim('Patio rope').segmentColors, renderPlaced(r.look('starter-ocean'), { segments: 15, index: 0 }));
      assert.ok(r.viaCloud('Patio rope').filter((i) => i === 'segmentedColorRgb').length >= 3);
      assert.equal(r.light('Patio rope').local, false, 'it is left to the cloud until it answers a scan again');
      assert.equal(r.light('Patio rope').localDesigns, false);
    } finally {
      await r.close();
    }
  });

  it('moves a multi-colour look in small steps that cost no requests', async () => {
    const r = await rig();
    try {
      r.ops.updateSettings({ localDesigns: ['H61A9'] });
      const rope = r.light('Patio rope');
      const look = r.ops.saveLook({ name: 'Flow', colors: [0xff0000, 0x00ff00, 0x0000ff], pattern: 'gradient', brightness: null, motion: { loopMinutes: 30 } });
      const before = Date.now();
      await (await r.hub.apply([rope.id], { type: 'look', lookId: look.id }, 'app')).done;
      const animation = r.store.data.animations[0];
      // 30 minutes over 3 colours, 60 steps between neighbours: every 10 seconds, not the two minutes the cloud would allow.
      assert.ok(Math.abs(animation.lights[0].nextAt - before - 10_000) < 1_000);

      const requests = r.store.requestsToday();
      const first = [...r.sim('Patio rope').segmentColors];
      r.reset();
      await r.hub.animator.tick(animation.startedAt + 5 * 60_000);
      assert.deepEqual(r.local('Patio rope').filter(([cmd]) => cmd === 'ptReal').length, 1);
      assert.notDeepEqual(r.sim('Patio rope').segmentColors, first, 'the colours have moved on');
      assert.deepEqual(r.sim('Patio rope').segmentColors, renderPlaced(look, { segments: 15, index: 0 }, 5 / 30));
      assert.equal(r.store.requestsToday(), requests);
    } finally {
      await r.close();
    }
  });

  it('is remembered, and is part of a backup', async () => {
    const r = await rig();
    try {
      r.ops.updateSettings({ localDesigns: ['H61A9', 'H61A9', 'H7086'] });
      assert.deepEqual(r.store.data.settings.localDesigns, ['H61A9', 'H7086']);
      const backups = new Backups(r.store, r.hub, path.join(tmp(), 'backups'), 'afterglow', () => undefined);
      const doc = JSON.parse(JSON.stringify(backups.document()));
      r.ops.updateSettings({ localDesigns: [] });
      assert.equal(r.light('Patio rope').localDesigns, false);
      backups.restore(doc);
      assert.deepEqual(r.store.data.settings.localDesigns, ['H61A9', 'H7086']);
      // The garden lights are switched on for it but do not answer locally, so nothing changes for them.
      assert.deepEqual([r.light('Patio rope').localDesigns, r.light('Front path lights').localDesigns], [true, false]);
    } finally {
      await r.close();
    }
  });
});

describe('trying local designs on a model', () => {
  it('sends each light the pattern by the local route only, whether or not the model is switched on', async () => {
    const r = await rig();
    try {
      const [first, second] = [r.light('Front fence rope').id, r.light('Patio rope').id];
      r.ops.saveGroup({ name: 'Walkway', deviceIds: [first, second], joined: true });
      await (await r.hub.apply(['all'], { type: 'power', on: false }, 'app')).done;
      r.reset();

      const result = await r.hub.testLocalDesigns('H61A9');
      assert.deepEqual(result, { sent: ['Front fence rope', 'Patio rope', 'Deck rail rope', 'Driveway rope'], failed: [] });
      const thirds = [...Array<number>(5).fill(0x00ff00), ...Array<number>(5).fill(0x0000ff), ...Array<number>(5).fill(0xff0000)];
      for (const name of result.sent) {
        // Green, blue, red on every light by itself, including the two that are joined end to end.
        assert.deepEqual(r.sim(name).segmentColors, thirds, name);
        assert.equal(r.sim(name).power, 1, 'the light is switched on so the pattern can be seen');
      }
      assert.equal(r.cloudSide.controls.length, 0);
      assert.equal(r.light('Patio rope').localDesigns, false, 'testing does not switch anything on');
      assert.match(r.store.data.activity[0].text, /^Test pattern sent over your network to 4 of 4 H61A9 lights$/);
    } finally {
      await r.close();
    }
  });

  it('cannot tell when a model ignores the message, which is why the owner has to look', async () => {
    const r = await rig();
    try {
      for (const l of r.cloudSide.lights.filter((x) => x.sku === 'H61A9')) r.lanSide.plain(l.device);
      const before = [...r.sim('Patio rope').segmentColors];
      const result = await r.hub.testLocalDesigns('H61A9');
      assert.equal(result.sent.length, 4, 'the lights answered, so as far as the app knows the pattern was sent');
      assert.deepEqual(r.sim('Patio rope').segmentColors, before, 'but they are showing what they showed before');
      assert.equal(r.cloudSide.controls.length, 0, 'and the cloud was not used to cover for it');
    } finally {
      await r.close();
    }
  });

  it('reports lights that do not answer, and refuses when none can be reached locally', async () => {
    const r = await rig();
    try {
      r.lanSide.mute(r.sim('Patio rope').device);
      const result = await r.hub.testLocalDesigns('H61A9');
      assert.deepEqual(result.failed, ['Patio rope']);
      assert.equal(result.sent.length, 3);
      assert.equal(r.viaCloud('Patio rope').includes('segmentedColorRgb'), false, 'a test never goes through the cloud');
      assert.equal(r.store.data.activity[0].detail, 'no answer from Patio rope');

      await assert.rejects(r.hub.testLocalDesigns('H7086'), /None of those lights answer on your network/);
      await assert.rejects(r.hub.testLocalDesigns('H0000'), /No lights of that model/);
    } finally {
      await r.close();
    }
  });
});

describe('spacing out messages to a light', () => {
  /** Applies a design to one rope whose simulated light is busy for 60 ms after each message. */
  const run = async (minGapMs: number) => {
    const r = await rig({ busyMs: 60, minGapMs });
    try {
      r.ops.updateSettings({ localDesigns: ['H61A9'] });
      const rope = r.light('Patio rope');
      await wait(100);
      const droppedBefore = r.lanSide.dropped;
      // Brightness and a design, each followed by a status query: four messages in a row.
      await (await r.hub.apply([rope.id], { type: 'look', lookId: 'starter-ember' }, 'app')).done;
      return { dropped: r.lanSide.dropped - droppedBefore, local: r.light('Patio rope').local, shown: [...r.sim('Patio rope').segmentColors], expected: renderPlaced(r.look('starter-ember'), { segments: 15, index: 0 }), on: r.sim('Patio rope').power };
    } finally {
      await r.close();
    }
  };

  it('leaves the light time to deal with each one, so none is lost', async () => {
    const { dropped, local, shown, expected, on } = await run(80);
    assert.equal(dropped, 0);
    assert.equal(local, true);
    assert.equal(on, 1);
    assert.deepEqual(shown, expected);
  });

  it('matters: sent back to back, messages are dropped by a busy light', async () => {
    const { dropped, local, shown, expected } = await run(0);
    assert.ok(dropped > 0, 'the simulated light drops messages that arrive while it is busy');
    assert.equal(local, false, 'which makes it look as if the light has gone');
    assert.deepEqual(shown, expected, 'so the design goes through the cloud instead');
  });
});
