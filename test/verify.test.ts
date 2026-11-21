import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Schedule } from '../shared/types';
import { GoveeCloud } from '../server/govee/cloud';
import { startFakeGovee, type FakeGovee } from '../server/govee/fake';
import { startFakeLan } from '../server/govee/fake-lan';
import { GoveeLan } from '../server/govee/lan';
import { Hub } from '../server/hub';
import { Ops } from '../server/ops';
import { Scheduler } from '../server/scheduler';
import { Store } from '../server/store';
import { CHECK_MINUTES } from '../server/verify';

const MIN = 60_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-verify-'));

describe('checking that a scheduled turn-off happened', () => {
  let fake: FakeGovee;
  let hub: Hub;
  let store: Store;
  let ops: Ops;
  let scheduler: Scheduler;
  let schedule: Schedule;
  let ids: string[];
  let t0: number;
  const dir = tmp();

  before(async () => {
    fake = await startFakeGovee({ latencyMs: 1 });
    store = new Store(dir);
    hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), store);
    ops = new Ops(store, hub, () => undefined);
    scheduler = new Scheduler(store, hub, () => undefined);
    scheduler.watcher.settleMs = 0;
    await hub.discover();
    ids = hub.list().slice(0, 3).map((d) => d.id);
    schedule = ops.saveSchedule({ name: 'Night', days: [0, 1, 2, 3, 4, 5, 6], start: { type: 'clock', time: '18:00' }, end: { type: 'clock', time: '07:00' }, targets: ids, action: { type: 'power', on: true } });
  });
  after(() => fake.close());

  /** Puts the three lights on, then turns them off the way a schedule's end does. */
  beforeEach(async () => {
    fake.ignoring.clear();
    fake.offline.clear();
    store.data.watches = [];
    store.data.activity = [];
    schedule.lastOff = null;
    await (await hub.apply(ids, { type: 'power', on: true }, 'app')).done;
  });
  const turnOff = async () => {
    const result = await hub.apply(ids, { type: 'power', on: false }, 'schedule');
    await result.done;
    t0 = Date.now();
    scheduler.watcher.watch(schedule, 'end', result.summary.applied, t0);
    fake.controls.length = 0;
  };
  const offsSent = (id: string) => fake.controls.filter((c) => c.device === id && c.capability.instance === 'powerSwitch' && c.capability.value === 0).length;
  const isOn = (id: string) => fake.lights.find((l) => l.device === id)!.power === 1;
  const log = () => store.data.activity.map((a) => a.text);

  it('confirms and stops when every light is off at the first check', async () => {
    await turnOff();
    assert.equal(scheduler.view(schedule).checkingOff, true);
    await scheduler.watcher.tick(t0 + 59_000);
    assert.equal(store.data.watches.length, 1, 'nothing happens before the first check is due');

    await scheduler.watcher.tick(t0 + 1 * MIN);
    assert.equal(store.data.watches.length, 0);
    assert.deepEqual(schedule.lastOff, { at: t0 + 1 * MIN, ok: true, text: 'Confirmed off' });
    assert.equal(scheduler.view(schedule).checkingOff, false);
    assert.equal(fake.controls.length, 0, 'no commands are repeated for lights that obeyed');
    assert.ok(log().includes('“Night” ended: lights confirmed off'));
  });

  it('sends "off" again to a light that missed it, then confirms', async () => {
    fake.ignoring.add(ids[1]); // accepts the command but stays on
    await turnOff();
    assert.equal(isOn(ids[1]), true);

    await scheduler.watcher.tick(t0 + 1 * MIN);
    assert.deepEqual(store.data.watches[0].lights, [ids[1]], 'only the light that is still on stays under watch');
    assert.equal(offsSent(ids[1]), 1);
    assert.equal(offsSent(ids[0]), 0);

    fake.ignoring.clear(); // from now on it listens
    await scheduler.watcher.tick(t0 + 3 * MIN);
    assert.equal(isOn(ids[1]), false);
    assert.equal(store.data.watches.length, 1, 'the resend is itself checked before the watch ends');

    await scheduler.watcher.tick(t0 + 10 * MIN);
    assert.equal(store.data.watches.length, 0);
    assert.equal(schedule.lastOff?.ok, true);
    assert.equal(schedule.lastOff?.text, `Confirmed off (${hub.nameOf(ids[1])} needed another try)`);
    assert.equal(offsSent(ids[1]), 2);
  });

  it('reports a light that never turns off, after trying at every check', async () => {
    fake.ignoring.add(ids[2]);
    await turnOff();
    for (const minutes of CHECK_MINUTES) await scheduler.watcher.tick(t0 + minutes * MIN);

    assert.equal(offsSent(ids[2]), CHECK_MINUTES.length);
    assert.deepEqual(store.data.watches.map((w) => w.lights), [[ids[2]]], 'the light is kept, to be tried again later');
    assert.equal(schedule.lastOff?.ok, false);
    assert.equal(schedule.lastOff?.text, `${hub.nameOf(ids[2])} is still on`);
    assert.equal(hub.list().find((d) => d.id === ids[2])!.error, 'Still on after “Night” ended');
    const entry = store.data.activity.find((a) => /ended, but/.test(a.text))!;
    assert.equal(entry.ok, false);
    assert.match(entry.text, /is still on/);
    assert.equal(hub.list().find((d) => d.id === ids[2])!.state.power, true, 'the app shows the light as it really is');
  });

  it('counts a light that obeys the very last resend as confirmed', async () => {
    fake.ignoring.add(ids[2]);
    await turnOff();
    for (const minutes of CHECK_MINUTES.slice(0, -1)) await scheduler.watcher.tick(t0 + minutes * MIN);
    fake.ignoring.clear();
    await scheduler.watcher.tick(t0 + CHECK_MINUTES.at(-1)! * MIN);
    assert.equal(isOn(ids[2]), false);
    assert.equal(schedule.lastOff?.ok, true);
    assert.match(schedule.lastOff?.text ?? '', /needed another try/);
  });

  it('says so when a light cannot be reached at all', async () => {
    fake.offline.add(ids[0]);
    await turnOff();
    for (const minutes of CHECK_MINUTES) await scheduler.watcher.tick(t0 + minutes * MIN);
    assert.equal(schedule.lastOff?.ok, false);
    assert.equal(schedule.lastOff?.text, `${hub.nameOf(ids[0])} could not be reached`);
    assert.match(hub.list().find((d) => d.id === ids[0])!.error ?? '', /Could not be reached to confirm it is off/);
  });

  it('turns a light off once it comes back within the hour', async () => {
    fake.offline.add(ids[0]);
    await turnOff();
    await scheduler.watcher.tick(t0 + 1 * MIN);
    await scheduler.watcher.tick(t0 + 3 * MIN);
    assert.equal(isOn(ids[0]), true);
    fake.offline.clear(); // back on the network
    await scheduler.watcher.tick(t0 + 10 * MIN);
    assert.equal(isOn(ids[0]), false);
    await scheduler.watcher.tick(t0 + 30 * MIN);
    assert.equal(schedule.lastOff?.ok, true);
  });

  it('leaves alone a light that someone turns back on', async () => {
    fake.ignoring.add(ids[0]);
    fake.ignoring.add(ids[1]);
    await turnOff();
    // Someone switches one of the still-on lights on deliberately, through the app.
    fake.ignoring.delete(ids[1]);
    await (await hub.apply([ids[1]], { type: 'color', rgb: 0x00ff00 }, 'app')).done;
    fake.controls.length = 0;
    assert.deepEqual(store.data.watches[0].lights.sort(), [ids[0], ids[2]].sort());

    await scheduler.watcher.tick(t0 + 1 * MIN);
    assert.equal(offsSent(ids[1]), 0, 'the light in use is not switched off again');
    assert.equal(isOn(ids[1]), true);
    assert.equal(offsSent(ids[0]), 1, 'the other light that missed it still gets a retry');
  });

  it('does not take back a light that someone uses while a resend is going out', async () => {
    fake.ignoring.add(ids[0]);
    fake.ignoring.add(ids[1]);
    await turnOff();
    // The moment the watcher resends "off", someone gives the second light a colour through the app.
    const apply = hub.apply.bind(hub);
    hub.apply = async (targets, action, source, opts) => {
      if (opts?.internal) await (await apply([ids[1]], { type: 'color', rgb: 0x00ff00 }, 'app')).done;
      return apply(targets, action, source, opts);
    };
    try {
      await scheduler.watcher.tick(t0 + 1 * MIN);
    } finally {
      hub.apply = apply;
    }
    assert.deepEqual(store.data.watches.map((w) => w.lights), [[ids[0]]], 'only the light nobody touched is still watched');
    fake.controls.length = 0;
    await scheduler.watcher.tick(t0 + 3 * MIN);
    assert.equal(offsSent(ids[1]), 0);
  });

  it('starts a check when a schedule ends, and picks it up again after a restart', async () => {
    store.data.watches = [];
    schedule.lastEnd = 0;
    const end = new Date();
    end.setHours(7, 0, 5, 0);
    await scheduler.tick(end);
    assert.equal(store.data.watches.length, 1);
    assert.deepEqual([...store.data.watches[0].lights].sort(), [...ids].sort());
    assert.equal(store.data.watches[0].scheduleId, schedule.id);
    await new Promise((r) => setTimeout(r, 1500)); // let the turn-off go out

    store.flush();
    const store2 = new Store(dir);
    const hub2 = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), store2);
    const scheduler2 = new Scheduler(store2, hub2, () => undefined);
    scheduler2.watcher.settleMs = 0;
    assert.equal(scheduler2.view(store2.data.schedules[0]).checkingOff, true);
    await scheduler2.watcher.tick(end.getTime() + 1 * MIN);
    assert.equal(store2.data.schedules[0].lastOff?.ok, true);
  });
});

describe('checking lights that answer on the local network', () => {
  it('asks the light itself, and retries locally', async () => {
    const cloudSide = await startFakeGovee({ latencyMs: 1 });
    const lanSide = await startFakeLan(cloudSide.lights.slice(0, 1));
    const lan = new GoveeLan({ scanAddress: '127.0.0.1', scanPort: lanSide.scanPort, listenPort: 0, statusTimeoutMs: 150 });
    try {
      await lan.start();
      for (let i = 0; i < 40 && lan.reachable().length < 1; i++) await new Promise((r) => setTimeout(r, 10));
      const store = new Store(tmp());
      const hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: cloudSide.url, onRequest: () => store.countRequest() }), store, lan);
      hub.confirmDelayMs = 5;
      const scheduler = new Scheduler(store, hub, () => undefined);
      scheduler.watcher.settleMs = 0;
      await hub.discover();
      const id = hub.list()[0].id;
      const schedule = { id: 's', name: 'Night' };

      await (await hub.apply([id], { type: 'power', on: false }, 'schedule')).done;
      const t0 = Date.now();
      scheduler.watcher.watch(schedule, 'end', [id], t0);
      cloudSide.lights[0].power = 1; // as if the light came back on by itself
      lanSide.received.length = 0;
      const requests = store.requestsToday();

      await scheduler.watcher.tick(t0 + 1 * MIN);
      assert.deepEqual(lanSide.received.map((r) => [r.cmd, r.data.value]), [['turn', 0]]);
      assert.equal(cloudSide.lights[0].power, 0);
      await scheduler.watcher.tick(t0 + 3 * MIN);
      assert.equal(store.data.watches.length, 0);
      assert.equal(store.requestsToday(), requests, 'checking and retrying a local light uses no cloud requests');
    } finally {
      lan.stop();
      await lanSide.close();
      await cloudSide.close();
    }
  });
});
