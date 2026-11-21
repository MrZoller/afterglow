import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { renderPlaced } from '../shared/looks';
import type { Schedule } from '../shared/types';
import { GoveeCloud } from '../server/govee/cloud';
import { startFakeGovee } from '../server/govee/fake';
import { Hub } from '../server/hub';
import { Notifier, type Notice } from '../server/notify';
import { Ops } from '../server/ops';
import { Scheduler } from '../server/scheduler';
import { Store } from '../server/store';
import { CATCH_UP_HOURS, CHECK_MINUTES, LATE_EVERY_MINUTES } from '../server/verify';

const MIN = 60_000;
const HOUR = 60 * MIN;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/** A clock time some minutes before now (negative for after), as a schedule would hold it. */
const ago = (minutes: number) => hhmm(new Date(Date.now() - minutes * MIN));
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** The app's moving parts against simulated lights, with notifications collected instead of sent. */
async function rig() {
  const fake = await startFakeGovee({ latencyMs: 1 });
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-catchup-')));
  const hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), store);
  const ops = new Ops(store, hub, () => undefined);
  const notices: Notice[] = [];
  const scheduler = new Scheduler(store, hub, () => undefined, (n) => notices.push(n));
  scheduler.watcher.settleMs = 0;
  await hub.discover();
  const id = (name: string) => hub.list().find((d) => d.goveeName === name)!.id;
  const sim = (name: string) => fake.lights.find((l) => l.deviceName === name)!;
  /** Sets every simulated light on or off behind the app's back, then lets the app see it. */
  const allPower = async (on: boolean) => {
    for (const light of fake.lights) light.power = on ? 1 : 0;
    await hub.refresh();
  };
  return {
    fake,
    store,
    hub,
    ops,
    scheduler,
    watcher: scheduler.watcher,
    notices,
    id,
    sim,
    allPower,
    light: (name: string) => hub.list().find((d) => d.goveeName === name)!,
    log: () => store.data.activity.map((a) => a.text),
    /** A schedule that looks as if it was saved long ago, so times already past today count as missed. */
    schedule(input: Record<string, unknown>): Schedule {
      const s = ops.saveSchedule({ days: EVERY_DAY, ...input });
      s.lastStart = s.lastEnd = Date.now() - 3 * 24 * HOUR;
      return s;
    },
    close: () => fake.close(),
  };
}

describe('a light that misses the start of a schedule', () => {
  it('is given its own share of the design once it can be reached', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const [a, b] = [r.id('Front path lights'), r.id('Flower bed lights')];
      const s = r.ops.saveSchedule({ name: 'Evening', days: EVERY_DAY, start: { type: 'clock', time: '18:00' }, targets: [a, b], action: { type: 'look', lookId: 'starter-liberty' } });
      r.fake.offline.add(b);

      // What the scheduler does when the schedule starts.
      const t0 = Date.now();
      s.lastStart = t0;
      const result = await r.hub.apply(s.targets, s.action, 'schedule');
      const watch = r.watcher.watch(s, 'start', result.summary.applied, t0)!;
      r.watcher.unsent(watch, (await result.done).failed.map((f) => f.deviceId));

      assert.deepEqual(r.scheduler.view(s).catchingUp, { kind: 'start', lights: ['Flower bed lights'] });
      assert.equal(r.scheduler.view(s).checkingOff, false);

      await r.watcher.tick(t0 + 1 * MIN);
      assert.deepEqual(r.store.data.watches[0].lights, [b], 'the light that obeyed is no longer watched');
      assert.equal(r.sim('Flower bed lights').power, 0);

      r.fake.offline.clear(); // back on the network
      await r.watcher.tick(t0 + 3 * MIN);
      assert.equal(r.sim('Flower bed lights').power, 1);
      // "One per light" hands out red, white, blue: the second light is white, not the first colour again.
      assert.deepEqual(r.light('Flower bed lights').state.appearance, { mode: 'color', rgb: 0xffffff });
      assert.deepEqual(r.light('Front path lights').state.appearance, { mode: 'color', rgb: 0xff1a2e });
      assert.equal(r.light('Flower bed lights').state.lookId, 'starter-liberty');
      assert.equal(r.scheduler.view(s).catchingUp, null);

      await r.watcher.tick(t0 + 10 * MIN);
      assert.equal(r.store.data.watches.length, 0);
      assert.ok(r.log().includes('“Evening” started: Flower bed lights needed another try'));
      assert.equal(r.notices.length, 0, 'put right before ten minutes were up, so nothing is sent to the phone');
    } finally {
      await r.close();
    }
  });

  it('gets its part of a run of lights joined end to end', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const [first, second] = [r.id('Front fence rope'), r.id('Patio rope')];
      const zone = r.ops.saveGroup({ name: 'Walkway', deviceIds: [first, second], joined: true });
      const look = r.store.data.looks.find((l) => l.id === 'starter-sunset')!;
      const s = r.ops.saveSchedule({ name: 'Evening', days: EVERY_DAY, start: { type: 'clock', time: '18:00' }, targets: [`group:${zone.id}`], action: { type: 'look', lookId: look.id } });
      r.fake.offline.add(second);

      const t0 = Date.now();
      s.lastStart = t0;
      const result = await r.hub.apply(s.targets, s.action, 'schedule');
      const watch = r.watcher.watch(s, 'start', result.summary.applied, t0)!;
      r.watcher.unsent(watch, (await result.done).failed.map((f) => f.deviceId));
      r.fake.offline.clear();
      await r.watcher.tick(t0 + 1 * MIN);

      const share = renderPlaced(look, { segments: 15, index: 0, offset: 15, total: 30 });
      assert.deepEqual(r.light('Patio rope').state.appearance, { mode: 'segments', colors: share });
      assert.notDeepEqual(share, renderPlaced(look, { segments: 15, index: 0 }), 'the second half of the run differs from the whole design on one rope');
    } finally {
      await r.close();
    }
  });

  it('joins a moving look where it has got to', async () => {
    const r = await rig();
    try {
      const [a, b] = [r.id('Front path lights'), r.id('Flower bed lights')];
      const look = r.store.data.looks.find((l) => l.id === 'starter-drift')!; // one colour per light, 30 minutes a loop
      const since = Date.now() - 15 * MIN;
      await (await r.hub.apply([a, b], { type: 'look', lookId: look.id }, 'schedule', { only: [b], since })).done;

      assert.equal(r.light('Front path lights').moving, false, 'the light that was not behind is left alone');
      assert.equal(r.light('Flower bed lights').moving, true);
      assert.equal(r.store.data.animations[0].startedAt, since);
      const shown = r.light('Flower bed lights').state.appearance;
      assert.deepEqual(shown, { mode: 'color', rgb: renderPlaced(look, { segments: 12, index: 1 }, 0.5)[0] }, 'half a loop on from where the look begins');
    } finally {
      await r.close();
    }
  });

  it('is forgotten if the schedule is changed or paused meanwhile', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const b = r.id('Flower bed lights');
      const input = { name: 'Evening', days: EVERY_DAY, start: { type: 'clock', time: '18:00' }, targets: [b], action: { type: 'color', rgb: 0xff0000 } };
      const s = r.ops.saveSchedule(input);
      r.fake.offline.add(b);
      const follow = async () => {
        const t0 = Date.now();
        s.lastStart = t0;
        const result = await r.hub.apply(s.targets, s.action, 'schedule');
        r.watcher.watch(s, 'start', result.summary.applied, t0);
        await result.done;
        return t0;
      };

      let t0 = await follow();
      await settle(5);
      r.ops.saveSchedule({ ...input, action: { type: 'color', rgb: 0x0000ff } }, s.id);
      r.fake.offline.clear();
      await r.watcher.tick(t0 + 1 * MIN);
      assert.equal(r.store.data.watches.length, 0);
      assert.equal(r.sim('Flower bed lights').power, 0, 'the old version of the schedule is not carried out');

      r.fake.offline.add(b);
      t0 = await follow();
      await settle(5);
      r.ops.setScheduleEnabled(s.id, false);
      r.fake.offline.clear();
      await r.watcher.tick(t0 + 1 * MIN);
      assert.equal(r.store.data.watches.length, 0);
      assert.equal(r.sim('Flower bed lights').power, 0);
    } finally {
      await r.close();
    }
  });

  it('is left alone once someone uses it', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const b = r.id('Flower bed lights');
      const s = r.ops.saveSchedule({ name: 'Evening', days: EVERY_DAY, start: { type: 'clock', time: '18:00' }, targets: [b], action: { type: 'color', rgb: 0xff0000 } });
      r.fake.ignoring.add(b);
      const t0 = Date.now();
      s.lastStart = t0;
      const result = await r.hub.apply(s.targets, s.action, 'schedule');
      r.watcher.watch(s, 'start', result.summary.applied, t0);
      await result.done;
      r.fake.ignoring.clear();

      await (await r.hub.apply([b], { type: 'power', on: false }, 'app')).done;
      r.fake.controls.length = 0;
      await r.watcher.tick(t0 + 1 * MIN);
      assert.equal(r.fake.controls.length, 0);
      assert.equal(r.store.data.watches.length, 0);
    } finally {
      await r.close();
    }
  });
});

describe('telling the phone', () => {
  it('says which lights are still on after ten minutes, and again when they go off', async () => {
    const r = await rig();
    try {
      await r.allPower(true);
      const [a, b, c] = [r.id('Front path lights'), r.id('Flower bed lights'), r.id('Back garden lights')];
      const s = r.ops.saveSchedule({ name: 'Night', days: EVERY_DAY, start: { type: 'clock', time: '18:00' }, end: { type: 'clock', time: '23:00' }, targets: [a, b, c], action: { type: 'power', on: true } });
      r.fake.ignoring.add(a); // hears "off" and stays on
      r.fake.offline.add(b); // has dropped off the network
      const result = await r.hub.apply(s.targets, { type: 'power', on: false }, 'schedule');
      await result.done;
      const t0 = Date.now();
      r.watcher.watch(s, 'end', result.summary.applied, t0);

      await r.watcher.tick(t0 + 1 * MIN);
      await r.watcher.tick(t0 + 3 * MIN);
      assert.equal(r.notices.length, 0, 'two tries are made before anyone is bothered');

      await r.watcher.tick(t0 + 10 * MIN);
      assert.equal(r.notices.length, 1);
      assert.equal(r.notices[0].title, 'Lights still on');
      assert.equal(r.notices[0].urgent, true);
      assert.match(r.notices[0].text, /^“Night” ended at .+, but Front path lights is still on; Flower bed lights could not be reached\. Afterglow will keep trying\.$/);
      assert.deepEqual(r.scheduler.view(s).catchingUp, { kind: 'end', lights: ['Front path lights', 'Flower bed lights'] });

      r.fake.ignoring.clear(); // the first light starts listening again
      await r.watcher.tick(t0 + 30 * MIN);
      assert.equal(r.sim('Front path lights').power, 0);
      assert.equal(r.notices.length, 1, 'a resend that worked is confirmed at the next check before it is reported');

      await r.watcher.tick(t0 + 60 * MIN);
      assert.equal(r.notices.length, 2);
      assert.deepEqual([r.notices[1].title, r.notices[1].urgent], ['Lights now off', undefined]);
      assert.equal(r.notices[1].text, 'Front path lights is off now, 60 minutes after “Night” ended.');
      assert.equal(s.lastOff?.text, 'Flower bed lights could not be reached');

      await r.watcher.tick(t0 + 70 * MIN);
      assert.equal(r.notices.length, 2, 'no second warning about a light already reported');
    } finally {
      await r.close();
    }
  });

  it('says when a light missed the start of a schedule, and when it has caught up', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const [a, b] = [r.id('Front path lights'), r.id('Flower bed lights')];
      const s = r.ops.saveSchedule({ name: 'Evening', days: EVERY_DAY, start: { type: 'clock', time: '18:00' }, targets: [a, b], action: { type: 'color', rgb: 0xff8800 } });
      r.fake.offline.add(b);
      const t0 = Date.now();
      s.lastStart = t0;
      const result = await r.hub.apply(s.targets, s.action, 'schedule');
      const watch = r.watcher.watch(s, 'start', result.summary.applied, t0)!;
      r.watcher.unsent(watch, (await result.done).failed.map((f) => f.deviceId));

      for (const minutes of [1, 3, 10]) await r.watcher.tick(t0 + minutes * MIN);
      assert.equal(r.notices.length, 1);
      assert.equal(r.notices[0].title, 'Lights missed a schedule');
      assert.match(r.notices[0].text, /^“Evening” started at .+, but Flower bed lights could not be reached\. Afterglow will keep trying\.$/);

      r.fake.offline.clear();
      await r.watcher.tick(t0 + 30 * MIN);
      await r.watcher.tick(t0 + 60 * MIN);
      assert.equal(r.sim('Flower bed lights').colorRgb, 0xff8800);
      assert.deepEqual(r.notices.slice(1).map((n) => [n.title, n.text]), [['Lights caught up', 'Flower bed lights has caught up with “Evening”, 60 minutes after it started.']]);
      assert.equal(r.store.data.watches.length, 0);
    } finally {
      await r.close();
    }
  });
});

describe('a light still wrong after the hour', () => {
  /** Ends a schedule with one light off the network, and runs every timed check. */
  const stuck = async () => {
    const r = await rig();
    await r.allPower(true);
    const [a, b] = [r.id('Front path lights'), r.id('Flower bed lights')];
    const s = r.ops.saveSchedule({ name: 'Night', days: EVERY_DAY, start: { type: 'clock', time: '18:00' }, end: { type: 'clock', time: '23:00' }, targets: [a, b], action: { type: 'power', on: true } });
    r.fake.offline.add(b);
    const result = await r.hub.apply(s.targets, { type: 'power', on: false }, 'schedule');
    await result.done;
    const t0 = Date.now();
    r.watcher.watch(s, 'end', result.summary.applied, t0);
    return { r, s, b, t0, timedChecks: async () => { for (const minutes of CHECK_MINUTES) await r.watcher.tick(t0 + minutes * MIN); } };
  };

  it('is switched off when it comes back, hours later', async () => {
    const { r, s, b, t0, timedChecks } = await stuck();
    try {
      await timedChecks();
      assert.equal(s.lastOff?.ok, false);
      assert.equal(r.scheduler.view(s).checkingOff, false, 'the hour of checks is over');
      assert.deepEqual(r.scheduler.view(s).catchingUp, { kind: 'end', lights: ['Flower bed lights'] });
      assert.match(r.light('Flower bed lights').error ?? '', /Could not be reached/);
      const report = r.store.data.activity.find((x) => /ended, but/.test(x.text))!;
      assert.equal(report.detail, `after 5 checks over 60 minutes; still trying every ${LATE_EVERY_MINUTES} minutes`);

      r.fake.controls.length = 0;
      await r.watcher.tick(t0 + 65 * MIN);
      assert.equal(r.fake.controls.length, 0, 'nothing is sent until the next try is due');
      await r.watcher.tick(t0 + 70 * MIN);
      assert.equal(r.fake.controls.filter((c) => c.device === b).length, 1);
      assert.equal(r.sim('Flower bed lights').power, 1, 'still off the network, still on');
      assert.match(r.light('Flower bed lights').error ?? '', /^Could not be reached to confirm it is off after “Night” ended$/, 'its note still says what went wrong, not just that the last command failed');

      r.fake.offline.clear(); // power back three hours after the schedule ended
      await r.watcher.tick(t0 + 3 * HOUR);
      assert.equal(r.sim('Flower bed lights').power, 0);
      assert.equal(r.store.data.watches.length, 0);
      assert.deepEqual(s.lastOff, { at: t0 + 3 * HOUR, ok: true, text: 'Confirmed off after 3 hours' });
      assert.ok(r.log().includes('Flower bed lights turned off 3 hours after “Night” ended'));
      assert.equal(r.light('Flower bed lights').error, null, 'its red note is cleared');
      assert.deepEqual(r.notices.map((n) => n.title), ['Lights still on', 'Lights now off']);
      assert.equal(r.scheduler.view(s).catchingUp, null);
    } finally {
      await r.close();
    }
  });

  it('is given up on after a day', async () => {
    const { r, t0, timedChecks } = await stuck();
    try {
      await timedChecks();
      await r.watcher.tick(t0 + 12 * HOUR);
      assert.equal(r.store.data.watches.length, 1);
      await r.watcher.tick(t0 + CATCH_UP_HOURS * HOUR);
      assert.equal(r.store.data.watches.length, 0);
      assert.ok(r.log().includes('Stopped trying to turn off Flower bed lights after “Night” ended'));
    } finally {
      await r.close();
    }
  });

  it('is dropped at the hour when catching up is switched off', async () => {
    const { r, s, timedChecks } = await stuck();
    try {
      r.ops.updateSettings({ catchUp: false });
      await timedChecks();
      assert.equal(r.store.data.watches.length, 0);
      assert.equal(s.lastOff?.ok, false);
      assert.equal(r.scheduler.view(s).catchingUp, null);
      assert.equal(r.store.data.activity.find((x) => /ended, but/.test(x.text))!.detail, 'after 5 checks over 60 minutes');
    } finally {
      await r.close();
    }
  });
});

describe('schedules missed while the app was not running', () => {
  it('starts a schedule late when its time passed but it has not ended', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const s = r.schedule({ name: 'Evening', start: { type: 'clock', time: ago(180) }, end: { type: 'clock', time: ago(-120) }, targets: ['all'], action: { type: 'look', lookId: 'starter-warm' } });
      const now = new Date();
      await r.scheduler.tick(now);
      await settle();

      assert.ok(r.fake.lights.every((l) => l.power === 1));
      assert.ok(r.hub.list().every((d) => d.state.lookId === 'starter-warm'));
      assert.equal(s.lastStart, now.getTime());
      assert.ok(r.log().includes('“Evening” started 3 hours late'));
      assert.deepEqual(r.store.data.watches.map((w) => [w.kind, w.lights.length]), [['start', 8]], 'and it is followed up like any other start');
      assert.equal(r.notices.length, 1);
      assert.equal(r.notices[0].title, 'Schedule ran late');
      assert.match(r.notices[0].text, /when “Evening” should have started\. It started at /);

      r.fake.controls.length = 0;
      await r.scheduler.tick(new Date(now.getTime() + 20_000));
      assert.equal(r.fake.controls.length, 0, 'once, not at every tick');
    } finally {
      await r.close();
    }
  });

  it('switches lights off late when the end of a schedule was missed', async () => {
    const r = await rig();
    try {
      await r.allPower(true); // on since last night
      const s = r.schedule({ name: 'Night', start: { type: 'clock', time: ago(20 * 60) }, end: { type: 'clock', time: ago(8 * 60) }, targets: ['all'], action: { type: 'power', on: true } });
      const now = new Date();
      await r.scheduler.tick(now);
      await settle();

      assert.ok(r.fake.lights.every((l) => l.power === 0));
      assert.ok(r.log().includes('“Night” ended 8 hours late'));
      assert.deepEqual(r.store.data.watches.map((w) => w.kind), ['end']);
      assert.match(r.notices[0].text, /when “Night” should have switched the lights off\. They were switched off at /);

      await r.watcher.tick(now.getTime() + 1 * MIN);
      assert.equal(s.lastOff?.text, 'Confirmed off');
    } finally {
      await r.close();
    }
  });

  it('gives each light only the last thing the schedules said', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const [a, b] = [r.id('Front path lights'), r.id('Flower bed lights')];
      r.schedule({ name: 'Early', start: { type: 'clock', time: ago(180) }, targets: [a, b], action: { type: 'color', rgb: 0xff0000 } });
      r.schedule({ name: 'Later', start: { type: 'clock', time: ago(120) }, targets: [b], action: { type: 'color', rgb: 0x0000ff } });
      await r.scheduler.tick(new Date());
      await settle();

      assert.equal(r.sim('Front path lights').colorRgb, 0xff0000);
      assert.equal(r.sim('Flower bed lights').colorRgb, 0x0000ff);
      const sentToB = r.fake.controls.filter((c) => c.device === b && c.capability.instance === 'colorRgb').map((c) => c.capability.value);
      assert.deepEqual(sentToB, [0x0000ff], 'the superseded colour is never sent');
      assert.ok(r.log().includes('Front path lights: colour #ff0000'), 'the log names the lights that were changed');
    } finally {
      await r.close();
    }
  });

  it('leaves alone a light that has been used since', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const [a, b] = [r.id('Front path lights'), r.id('Flower bed lights')];
      r.schedule({ name: 'Evening', start: { type: 'clock', time: ago(180) }, targets: [a, b], action: { type: 'color', rgb: 0xff0000 } });
      await (await r.hub.apply([a], { type: 'color', rgb: 0x00ff00 }, 'app')).done;
      await r.scheduler.tick(new Date());
      await settle();

      assert.equal(r.sim('Front path lights').colorRgb, 0x00ff00);
      assert.equal(r.sim('Flower bed lights').colorRgb, 0xff0000);
    } finally {
      await r.close();
    }
  });

  it('does nothing late when catching up is switched off, but still runs on time', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      r.ops.updateSettings({ catchUp: false });
      const a = r.id('Front path lights');
      const missed = r.schedule({ name: 'Missed', start: { type: 'clock', time: ago(180) }, targets: [a], action: { type: 'power', on: true } });
      await r.scheduler.tick(new Date());
      await settle();
      assert.equal(r.sim('Front path lights').power, 0);
      assert.ok(missed.lastStart! < Date.now() - HOUR, 'it is not marked as having run');

      r.schedule({ name: 'Due', start: { type: 'clock', time: ago(0) }, targets: [a], action: { type: 'power', on: true } });
      await r.scheduler.tick(new Date());
      await settle();
      assert.equal(r.sim('Front path lights').power, 1);
      assert.equal(r.notices.length, 0);
    } finally {
      await r.close();
    }
  });

  it('ignores anything more than a day old, and schedules saved after their time today', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const a = r.id('Front path lights');
      const twoDaysAgo = new Date(Date.now() - 47 * HOUR);
      r.schedule({ name: 'Old', days: [twoDaysAgo.getDay()], start: { type: 'clock', time: hhmm(twoDaysAgo) }, targets: [a], action: { type: 'power', on: true } });
      r.ops.saveSchedule({ name: 'New', days: EVERY_DAY, start: { type: 'clock', time: ago(180) }, targets: [a], action: { type: 'power', on: true } });
      await r.scheduler.tick(new Date());
      await settle();
      assert.equal(r.sim('Front path lights').power, 0);
      assert.equal(r.fake.controls.length, 0);
    } finally {
      await r.close();
    }
  });

  it('follows up a start that ran on time with a light off the network', async () => {
    const r = await rig();
    try {
      await r.allPower(false);
      const [a, b] = [r.id('Front path lights'), r.id('Flower bed lights')];
      const s = r.schedule({ name: 'Due', start: { type: 'clock', time: ago(0) }, targets: [a, b], action: { type: 'color', rgb: 0xff0000 } });
      r.fake.offline.add(b);
      const now = new Date();
      await r.scheduler.tick(now);
      await settle();

      assert.deepEqual(r.store.data.watches.map((w) => [w.kind, w.unsent]), [['start', [b]]]);
      assert.deepEqual(r.scheduler.view(s).catchingUp, { kind: 'start', lights: ['Flower bed lights'] });
      assert.equal(r.log().some((text) => /late/.test(text)), false, 'a run within ten minutes of its time is not called late');

      r.fake.offline.clear();
      await r.watcher.tick(now.getTime() + 1 * MIN);
      assert.equal(r.sim('Flower bed lights').colorRgb, 0xff0000);
    } finally {
      await r.close();
    }
  });
});

describe('the record of lights dropping off the network', () => {
  it('notes when a light goes and when it comes back', async () => {
    const r = await rig();
    try {
      const b = r.id('Flower bed lights');
      await r.hub.refresh();
      assert.deepEqual(r.light('Flower bed lights').dropouts, { week: 0, last: null });

      r.fake.offline.add(b);
      await r.hub.refresh();
      await r.hub.refresh(); // seeing it offline twice is still one dropout
      const during = r.light('Flower bed lights').dropouts;
      assert.equal(during.week, 1);
      assert.equal(during.last?.to, null);
      assert.equal(r.light('Front path lights').dropouts.week, 0);

      r.fake.offline.clear();
      await r.hub.refresh();
      const after = r.light('Flower bed lights').dropouts;
      assert.equal(after.week, 1);
      assert.ok(after.last!.to! >= after.last!.from);

      r.fake.offline.add(b);
      await r.hub.refresh();
      assert.equal(r.light('Flower bed lights').dropouts.week, 2);
    } finally {
      await r.close();
    }
  });

  it('forgets dropouts older than a week in the count, and older than two in the record', async () => {
    const r = await rig();
    try {
      const b = r.id('Flower bed lights');
      const day = 24 * HOUR;
      r.store.data.outages = [
        { deviceId: b, from: Date.now() - 20 * day, to: Date.now() - 20 * day + HOUR },
        { deviceId: b, from: Date.now() - 9 * day, to: Date.now() - 9 * day + HOUR },
        { deviceId: b, from: Date.now() - 2 * day, to: Date.now() - 2 * day + HOUR },
      ];
      assert.equal(r.light('Flower bed lights').dropouts.week, 1);
      r.fake.offline.add(b);
      await r.hub.refresh();
      assert.equal(r.store.data.outages.length, 3, 'the oldest has been dropped and the new one added');
      assert.equal(r.light('Flower bed lights').dropouts.week, 2);
    } finally {
      await r.close();
    }
  });
});

describe('sending a notification', () => {
  /** A stand-in for the notification service: records what arrives and answers with the statuses given, then 200. */
  const receiver = async (statuses: number[] = []) => {
    const got: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        got.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
        res.writeHead(statuses.shift() ?? 200).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { got, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/my-topic`, close: () => new Promise((resolve) => server.close(resolve)) };
  };

  it('posts the message with its title, priority and a link back to the app', async () => {
    const stub = await receiver();
    try {
      const notifier = new Notifier({ url: stub.url, token: 'tk_secret', link: () => 'http://mac-mini.example.ts.net:4680' });
      assert.equal(notifier.enabled, true);
      await notifier.deliver({ title: 'Lights still on', text: '“Night” ended at 7:00, but Walkway is still on.', urgent: true });
      await notifier.deliver({ title: 'Lights now off', text: 'Walkway is off now.' });

      const [first, second] = stub.got;
      assert.deepEqual([first.method, first.path], ['POST', '/my-topic']);
      assert.equal(first.body, '“Night” ended at 7:00, but Walkway is still on.');
      assert.equal(first.headers.title, 'Lights still on');
      assert.equal(first.headers.priority, 'high');
      assert.equal(first.headers.tags, 'warning');
      assert.equal(first.headers.click, 'http://mac-mini.example.ts.net:4680');
      assert.equal(first.headers.authorization, 'Bearer tk_secret');
      assert.deepEqual([second.headers.priority, second.headers.tags], ['default', 'bulb']);
    } finally {
      await stub.close();
    }
  });

  it('tries again when it does not get through, then records success', async () => {
    const stub = await receiver([500, 503]);
    try {
      const notifier = new Notifier({ url: stub.url, retryMs: [5, 5, 5] });
      notifier.send({ title: 'T', text: 'x' });
      await settle(200);
      assert.equal(stub.got.length, 3);
      assert.equal(notifier.error, null);
      assert.ok(notifier.lastAt);
      assert.equal(stub.got[0].headers.authorization, undefined, 'no token is sent when none is set');
    } finally {
      await stub.close();
    }
  });

  it('gives up after its last try and says why', async () => {
    const stub = await receiver([403, 403]);
    try {
      const failures: string[] = [];
      const notifier = new Notifier({ url: stub.url, retryMs: [5], onFailure: (reason) => failures.push(reason) });
      notifier.send({ title: 'T', text: 'x' });
      await settle(200);
      assert.equal(stub.got.length, 2);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /answered 403 \(check NOTIFY_TOKEN/);
      assert.equal(notifier.lastAt, null);
    } finally {
      await stub.close();
    }
  });

  it('reports a test that fails, and an address that is not one', async () => {
    const stub = await receiver([404]);
    try {
      await assert.rejects(new Notifier({ url: stub.url }).test(), /answered 404/);
      const dead = new Notifier({ url: 'http://127.0.0.1:9/topic', timeoutMs: 500 });
      await assert.rejects(dead.test(), /127\.0\.0\.1:9: (could not connect|no answer)/);

      const off = new Notifier({ url: '' });
      assert.deepEqual([off.enabled, off.error], [false, null]);
      off.send({ title: 'T', text: 'x' }); // nothing to do, and nothing thrown
      const wrong = new Notifier({ url: 'ntfy.sh/topic' });
      assert.equal(wrong.enabled, false);
      assert.match(wrong.error ?? '', /not a web address/);
    } finally {
      await stub.close();
    }
  });
});
