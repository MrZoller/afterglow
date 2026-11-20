process.env.TZ = 'America/Denver';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { groupByColor, MAX_BANDS, renderLook } from '../shared/looks';
import type { Schedule } from '../shared/types';
import { GoveeCloud, parseDevice } from '../server/govee/cloud';
import { startFakeGovee, type FakeGovee } from '../server/govee/fake';
import { Hub } from '../server/hub';
import { Ops } from '../server/ops';
import { inSeason, nextEvent, occurrence, resolveTime, Scheduler } from '../server/scheduler';
import { Store } from '../server/store';

const DENVER = { lat: 39.74, lon: -104.99, label: 'Denver' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-test-'));

const schedule = (patch: Partial<Schedule>): Schedule => ({
  id: 's1',
  name: 'Test',
  enabled: true,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: { type: 'clock', time: '18:00' },
  end: null,
  season: null,
  targets: ['all'],
  action: { type: 'power', on: true },
  lastStart: null,
  lastEnd: null,
  ...patch,
});

describe('looks', () => {
  const colors = [0xff0000, 0x00ff00, 0x0000ff];

  it('draws gradients in a limited number of bands', () => {
    const out = renderLook({ colors, pattern: 'gradient' }, 15);
    assert.equal(out.length, 15);
    assert.equal(out[0], 0xff0000);
    assert.equal(out[14], 0x0000ff);
    assert.ok(new Set(out).size <= MAX_BANDS);
  });

  it('splits blocks evenly and alternates segment by segment', () => {
    assert.deepEqual(renderLook({ colors, pattern: 'blocks' }, 6), [0xff0000, 0xff0000, 0x00ff00, 0x00ff00, 0x0000ff, 0x0000ff]);
    assert.deepEqual(renderLook({ colors, pattern: 'alternate' }, 4), [0xff0000, 0x00ff00, 0x0000ff, 0xff0000]);
  });

  it('gives each light the next colour for perLight, and for lights without segments', () => {
    assert.deepEqual(renderLook({ colors, pattern: 'perLight' }, 3, 1), [0x00ff00, 0x00ff00, 0x00ff00]);
    assert.deepEqual(renderLook({ colors, pattern: 'gradient' }, 0, 2), [0x0000ff]);
  });

  it('stretches a painted design to another segment count', () => {
    assert.deepEqual(renderLook({ colors, pattern: 'custom', segments: [1, 2] }, 4), [1, 1, 2, 2]);
  });

  it('groups segments by colour', () => {
    assert.deepEqual(groupByColor([5, 7, 5]), [
      { rgb: 5, segments: [0, 2] },
      { rgb: 7, segments: [1] },
    ]);
  });
});

describe('device parsing', () => {
  const base = { sku: 'H61A9', device: 'AA', deviceName: 'Rope' };
  const power = { type: 'devices.capabilities.on_off', instance: 'powerSwitch' };
  const segments = (field: object) => ({ type: 'devices.capabilities.segment_color_setting', instance: 'segmentedColorRgb', parameters: { fields: [{ fieldName: 'segment', ...field }] } });

  it('reads the segment count from either form Govee uses', () => {
    assert.equal(parseDevice({ ...base, capabilities: [power, segments({ elementRange: { min: 0, max: 14 } })] })?.caps.segments, 15);
    assert.equal(parseDevice({ ...base, capabilities: [power, segments({ options: [{ value: 0 }, { value: 1 }, { value: 2 }] })] })?.caps.segments, 3);
    assert.equal(parseDevice({ ...base, capabilities: [power] })?.caps.segments, 0);
  });

  it('ignores devices that cannot be switched', () => {
    assert.equal(parseDevice({ ...base, capabilities: [{ type: 'devices.capabilities.property', instance: 'sensorTemperature' }] }), null);
  });
});

describe('schedule times', () => {
  it('resolves clock and sun times on a local day', () => {
    const day = new Date(2026, 5, 21);
    assert.equal(resolveTime({ type: 'clock', time: '18:30' }, day, null)?.getHours(), 18);
    const sunset = resolveTime({ type: 'sun', event: 'sunset', offsetMin: 0 }, day, DENVER)!;
    assert.equal(sunset.getDate(), 21);
    assert.equal(sunset.getHours(), 20); // about 8:31 PM in Denver at midsummer
    const winter = resolveTime({ type: 'sun', event: 'sunset', offsetMin: -30 }, new Date(2026, 11, 21), DENVER)!;
    assert.equal(winter.getHours(), 16); // about 4:39 PM, less 30 minutes
    assert.equal(resolveTime({ type: 'sun', event: 'sunset', offsetMin: 0 }, day, null), null);
  });

  it('handles seasons that wrap the new year', () => {
    const season = { from: '12-01', to: '01-06' };
    assert.ok(inSeason(season, new Date(2026, 11, 25)));
    assert.ok(inSeason(season, new Date(2027, 0, 6)));
    assert.ok(!inSeason(season, new Date(2027, 0, 7)));
    assert.ok(!inSeason(season, new Date(2026, 10, 30)));
  });

  it('moves an end time earlier than the start to the next day', () => {
    const occ = occurrence(schedule({ start: { type: 'clock', time: '19:00' }, end: { type: 'clock', time: '01:00' } }), new Date(2026, 5, 1), null)!;
    assert.equal(occ.end!.getDate(), 2);
    assert.equal(occ.end!.getHours(), 1);
  });

  it('finds the next event, respecting days and seasons', () => {
    const now = new Date(2026, 5, 1, 20, 0); // a Monday evening
    const s = schedule({ start: { type: 'clock', time: '19:00' }, end: { type: 'clock', time: '23:00' } });
    assert.deepEqual(nextEvent(s, now, null), { at: new Date(2026, 5, 1, 23, 0).getTime(), kind: 'end' });
    const weekends = schedule({ days: [0, 6] });
    assert.equal(new Date(nextEvent(weekends, now, null)!.at).getDay(), 6);
    const holiday = schedule({ season: { from: '12-01', to: '01-06' } });
    assert.deepEqual(nextEvent(holiday, now, null), { at: new Date(2026, 11, 1, 18, 0).getTime(), kind: 'start' });
  });
});

describe('hub against the simulated Govee service', () => {
  let fake: FakeGovee;
  let hub: Hub;
  let store: Store;
  let ops: Ops;

  before(async () => {
    fake = await startFakeGovee({ latencyMs: 1 });
    store = new Store(tmp());
    hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), store);
    ops = new Ops(store, hub, () => undefined);
    await hub.discover();
  });
  after(() => fake.close());

  const rope = () => hub.list().find((d) => d.sku === 'H61A9')!;
  const garden = () => hub.list().find((d) => d.sku === 'H7086')!;
  const sent = (deviceId: string) => fake.controls.filter((c) => c.device === deviceId).map((c) => c.capability);
  const reset = () => (fake.controls.length = 0);

  it('discovers the lights and their capabilities', async () => {
    assert.equal(hub.list().length, 8);
    assert.equal(rope().caps.segments, 15);
    assert.equal(garden().caps.segments, 12);
    await hub.refresh();
    assert.equal(rope().state.power, true);
    assert.equal(rope().state.brightness, 80);
    assert.deepEqual(rope().state.appearance, { mode: 'color', rgb: 0xff8a1f });
  });

  it('applies a look as power, brightness and one command per colour', async () => {
    reset();
    const look = ops.saveLook({ name: 'Tri', colors: [0xff0000, 0x00ff00, 0x0000ff], pattern: 'blocks', brightness: 40 });
    const id = rope().id;
    const result = await hub.apply([id], { type: 'look', lookId: look.id }, 'schedule');
    assert.deepEqual(await result.done, { failed: [] });
    assert.deepEqual(sent(id), [
      { type: 'devices.capabilities.on_off', instance: 'powerSwitch', value: 1 },
      { type: 'devices.capabilities.range', instance: 'brightness', value: 40 },
      { type: 'devices.capabilities.segment_color_setting', instance: 'segmentedColorRgb', value: { segment: [0, 1, 2, 3, 4], rgb: 0xff0000 } },
      { type: 'devices.capabilities.segment_color_setting', instance: 'segmentedColorRgb', value: { segment: [5, 6, 7, 8, 9], rgb: 0x00ff00 } },
      { type: 'devices.capabilities.segment_color_setting', instance: 'segmentedColorRgb', value: { segment: [10, 11, 12, 13, 14], rgb: 0x0000ff } },
    ]);
    assert.equal(rope().state.lookId, look.id);
    assert.equal(rope().state.appearance.mode, 'segments');
  });

  it('sends a single colour as one command and skips power when already on', async () => {
    reset();
    const id = rope().id;
    await (await hub.apply([id], { type: 'color', rgb: 0x123456 }, 'app')).done;
    assert.deepEqual(sent(id), [{ type: 'devices.capabilities.color_setting', instance: 'colorRgb', value: 0x123456 }]);
    assert.equal(rope().state.lookId, null);
  });

  it('applies scenes by name with the value each model expects, and skips lights without them', async () => {
    reset();
    const result = await hub.apply(['all'], { type: 'scene', scene: { kind: 'light', name: 'ocean' } }, 'app');
    await result.done;
    assert.equal(result.summary.applied.length, 4);
    assert.equal(result.summary.skipped.length, 4);
    assert.match(result.summary.skipped[0].reason, /no scene called/);
    const scene = sent(rope().id).find((c) => c.instance === 'lightScene');
    assert.deepEqual(scene, { type: 'devices.capabilities.dynamic_scene', instance: 'lightScene', value: { paramId: 4004, id: 3004 } });

    reset();
    await (await hub.apply([rope().id], { type: 'scene', scene: { kind: 'diy', name: 'My chase' } }, 'app')).done;
    assert.equal(sent(rope().id).at(-1)?.value, 8216567);
    assert.deepEqual(rope().state.appearance, { mode: 'scene', scene: { kind: 'diy', name: 'My chase' } });
  });

  it('lists scenes with how many lights support each', async () => {
    const { scenes, lights } = await hub.scenes(['all']);
    assert.equal(lights, 8);
    assert.equal(scenes.find((s) => s.name === 'Sunset')?.supported, 8);
    assert.equal(scenes.find((s) => s.name === 'Ocean')?.supported, 4);
    assert.ok(scenes.some((s) => s.kind === 'snapshot' && s.name === 'Movie night'));
  });

  it('lets a newer command replace older ones still waiting', async () => {
    reset();
    const id = garden().id;
    const results = [];
    for (const value of [10, 20, 30, 40, 50, 60, 70, 80]) results.push(await hub.apply([id], { type: 'brightness', value }, 'app'));
    await Promise.all(results.map((r) => r.done));
    const values = sent(id).map((c) => c.value);
    assert.ok(values.length < 8, `expected some to be dropped, sent ${values}`);
    assert.equal(values.at(-1), 80);
    assert.equal(garden().state.brightness, 80);
  });

  it('rejects unknown targets and missing looks', async () => {
    await assert.rejects(hub.apply(['nope'], { type: 'power', on: true }, 'app'), /No lights match/);
    await assert.rejects(hub.apply(['all'], { type: 'look', lookId: 'missing' }, 'app'), /no longer exists/);
  });

  it('fires a schedule once at its start and once at its end', async () => {
    const scheduler = new Scheduler(store, hub, () => undefined);
    const id = garden().id;
    const s = ops.saveSchedule({ name: 'Evening', days: [0, 1, 2, 3, 4, 5, 6], start: { type: 'clock', time: '18:00' }, end: { type: 'clock', time: '23:00' }, targets: [id], action: { type: 'color', rgb: 0xabcdef } });
    s.lastStart = s.lastEnd = new Date(2026, 5, 1, 12, 0).getTime();
    const settle = () => new Promise((r) => setTimeout(r, 1500));

    reset();
    await scheduler.tick(new Date(2026, 5, 1, 17, 59));
    assert.equal(sent(id).length, 0);
    await scheduler.tick(new Date(2026, 5, 1, 18, 0, 10));
    await scheduler.tick(new Date(2026, 5, 1, 18, 0, 30));
    await settle();
    assert.deepEqual(sent(id).map((c) => [c.instance, c.value]), [
      ['powerSwitch', 1],
      ['colorRgb', 0xabcdef],
    ]);

    reset();
    await scheduler.tick(new Date(2026, 5, 1, 23, 0, 5));
    await scheduler.tick(new Date(2026, 5, 1, 23, 0, 25));
    await settle();
    assert.deepEqual(sent(id).map((c) => [c.instance, c.value]), [['powerSwitch', 0]]);

    // Too late to catch up: a start missed by more than the grace period is skipped.
    reset();
    await scheduler.tick(new Date(2026, 5, 2, 18, 30));
    await settle();
    assert.equal(sent(id).length, 0);
    ops.deleteSchedule(s.id);
  });
});

describe('rate limits', () => {
  it('waits and retries when Govee says to slow down', async () => {
    const fake = await startFakeGovee({ latencyMs: 1, limit: { max: 3, windowMs: 2000 } });
    try {
      const hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), new Store(tmp()));
      await hub.discover();
      const id = hub.list()[0].id;
      const started = Date.now();
      // Power on plus four colours is five commands; the service allows three per window.
      const result = await hub.apply([id], { type: 'segments', colors: [1, 2, 3, 4] }, 'app');
      const { failed } = await result.done;
      assert.equal(failed.length, 0);
      assert.equal(fake.controls.length, 5);
      assert.ok(Date.now() - started >= 1000, 'the last commands should have waited for the limit to clear');
      assert.equal(hub.list()[0].error, null);
      assert.equal(hub.list()[0].pending, 0);
    } finally {
      await fake.close();
    }
  });

  it('reports a failure on the light when Govee rejects a command', async () => {
    const fake = await startFakeGovee({ latencyMs: 1 });
    try {
      const store = new Store(tmp());
      const hub = new Hub(new GoveeCloud({ apiKey: 'test', baseUrl: fake.url }), store);
      await hub.discover();
      const id = hub.list()[0].id;
      fake.lights.splice(0, 1); // the light disappears from the account
      const { failed } = await (await hub.apply([id], { type: 'power', on: false }, 'app')).done;
      assert.equal(failed.length, 1);
      assert.match(failed[0].error, /device not found/);
      assert.match(hub.list()[0].error ?? '', /device not found/);
      assert.equal(store.data.activity[0].ok, false);
    } finally {
      await fake.close();
    }
  });
});
