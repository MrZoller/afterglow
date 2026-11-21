import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GoveeCloud, isGoveeGroup } from '../server/govee/cloud';
import { startFakeGovee } from '../server/govee/fake';
import { Hub } from '../server/hub';
import { Ops } from '../server/ops';
import { Scheduler } from '../server/scheduler';
import { Store } from '../server/store';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-groups-'));
const MIN = 60_000;

describe('groups made in the Govee app', () => {
  it('are recognised by the model names Govee gives them', () => {
    for (const sku of ['SameModeGroup', 'DreamViewScenic', 'BaseGroup']) assert.equal(isGoveeGroup({ sku, device: '123', deviceName: 'Yard' }), true, sku);
    assert.equal(isGoveeGroup({ sku: 'H61A9', device: 'AA:BB:CC:DD:EE:FF:11:22' }), false);
    assert.equal(isGoveeGroup({ sku: 'H7086', device: '1234567890' }), false, 'a light is not mistaken for a group because of how its id looks');
    assert.equal(isGoveeGroup(null), false);
  });

  it('are left out of the lights, and named so the owner knows where they went', async () => {
    const fake = await startFakeGovee({ latencyMs: 1 });
    try {
      const store = new Store(tmp());
      const cloud = new GoveeCloud({ apiKey: 'test', baseUrl: fake.url });
      const hub = new Hub(cloud, store);
      await hub.discover();
      assert.equal(hub.list().length, 8);
      assert.equal(hub.list().some((d) => /Group|Scenic/.test(d.sku)), false);
      assert.deepEqual(cloud.groups, ['All ropes', 'Front scene', 'Whole yard']);
      assert.deepEqual(cloud.groups, fake.groups);

      // "All lights" reaches the eight lights and nothing else.
      const result = await hub.apply(['all'], { type: 'power', on: true }, 'app');
      await result.done;
      assert.equal(result.summary.applied.length, 8);
      assert.equal(new Set(fake.controls.map((c) => c.device)).size, 8);
    } finally {
      await fake.close();
    }
  });

  it('are dropped from a setup that listed them as lights, without disturbing the rest', async () => {
    const fake = await startFakeGovee({ latencyMs: 1 });
    try {
      const dir = tmp();
      const store = new Store(dir);
      const hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), store);
      const ops = new Ops(store, hub, () => undefined);
      await hub.discover();
      const light = hub.list()[4];
      hub.update(light.id, { name: 'Path' });
      const zone = ops.saveGroup({ name: 'Front', deviceIds: [light.id] });

      // As an earlier version left it: a group stored among the lights, in a zone, and being checked after a schedule.
      store.data.devices.push({ info: { ...store.data.devices[0].info, id: '11849032', sku: 'SameModeGroup', goveeName: 'All ropes' }, alias: null, state: { ...store.data.devices[0].state } });
      store.data.groups.find((g) => g.id === zone.id)!.deviceIds.push('11849032');
      store.data.watches.push({ id: 'w', scheduleId: 's', label: 'Night', kind: 'end', startedAt: Date.now(), check: 0, lights: ['11849032', light.id], retried: [] });
      store.flush();

      const store2 = new Store(dir);
      const hub2 = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), store2);
      const scheduler = new Scheduler(store2, hub2, () => undefined);
      scheduler.watcher.settleMs = 0;
      assert.equal(hub2.list().length, 9, 'before Govee has been asked again, the stored list still has it');
      await hub2.discover();
      assert.equal(hub2.list().length, 8);
      assert.equal(hub2.list().find((d) => d.id === light.id)!.name, 'Path', 'names given to real lights are kept');
      assert.deepEqual(hub2.deviceIds([`group:${zone.id}`]), [light.id], 'a zone that listed the group now reaches only its real lights');

      // The check after a schedule no longer waits on something that is not a light.
      await (await hub2.apply([light.id], { type: 'power', on: false }, 'schedule', { internal: true, quiet: true })).done;
      await scheduler.watcher.tick(Date.now() + 1 * MIN);
      assert.equal(store2.data.watches.length, 0);
      assert.equal(store2.data.activity[0].text, '“Night” ended: lights confirmed off');
    } finally {
      await fake.close();
    }
  });
});
