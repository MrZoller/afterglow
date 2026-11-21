import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Backups } from '../server/backup';
import { GoveeCloud } from '../server/govee/cloud';
import { startFakeGovee, type FakeGovee } from '../server/govee/fake';
import { Hub } from '../server/hub';
import { Ops } from '../server/ops';
import { Store } from '../server/store';

describe('backups', () => {
  let fake: FakeGovee;
  let hub: Hub;
  let store: Store;
  let ops: Ops;
  let backups: Backups;
  let restored = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-backup-'));
  const backupDir = path.join(dir, 'backups');
  const files = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : []);

  before(async () => {
    fake = await startFakeGovee({ latencyMs: 1 });
    store = new Store(dir);
    hub = new Hub(new GoveeCloud({ apiKey: 'secret-api-key', baseUrl: fake.url }), store);
    ops = new Ops(store, hub, () => undefined);
    backups = new Backups(store, hub, backupDir, 'afterglow', () => restored++);
    await hub.discover();

    const ids = hub.list().map((d) => d.id);
    const zone = ops.saveGroup({ name: 'Right walkway', deviceIds: [ids[0], ids[1]], joined: true });
    const look = ops.saveLook({ name: 'Mine', colors: [0xff0000, 0x00ff00], pattern: 'gradient', brightness: 40, motion: { loopMinutes: 30 } });
    ops.saveSchedule({ name: 'Evening', days: [0, 1, 2, 3, 4, 5, 6], start: { type: 'sun', event: 'sunset', offsetMin: -15 }, end: { type: 'clock', time: '23:00' }, targets: [`group:${zone.id}`], action: { type: 'look', lookId: look.id } });
    ops.updateSettings({ location: { lat: 39.74, lon: -104.99, label: 'Home' }, swatches: [0x123456], catchUp: false });
    hub.update(ids[0], { name: 'Walkway A', reversed: true });
    hub.setOrder([ids[3], ...ids.filter((id) => id !== ids[3])]);
    await (await hub.apply(['all'], { type: 'power', on: true }, 'app')).done;
  });
  after(() => fake.close());

  it('captures the setup, and leaves out secrets and passing state', () => {
    const doc = backups.document();
    assert.equal(doc.app, 'afterglow');
    assert.ok(doc.looks.some((l) => l.name === 'Mine' && l.motion?.loopMinutes === 30));
    assert.deepEqual(doc.groups.map((g) => [g.name, g.joined]), [['Right walkway', true]]);
    assert.equal(doc.schedules[0].name, 'Evening');
    assert.equal(doc.settings.location?.label, 'Home');
    assert.deepEqual(doc.lights[1].name === null || typeof doc.lights[1].name === 'string', true);
    assert.deepEqual(doc.lights.find((l) => l.name === 'Walkway A'), { id: hub.list().find((d) => d.name === 'Walkway A')!.id, goveeName: 'Front fence rope', name: 'Walkway A', reversed: true });
    assert.equal(doc.lights.filter((l) => l.name === null).length, 7, 'lights without their own name are stored as such');

    const text = JSON.stringify(doc);
    assert.ok(!text.includes('secret-api-key'));
    for (const key of ['activity', 'usage', 'lastStart', 'lastEnd', 'lastOff', 'animations', 'watches', 'outages', 'state', 'scenes', 'devices']) assert.ok(!text.includes(`"${key}"`), `${key} should not be in a backup`);
  });

  it('makes one snapshot a day and keeps two weeks of them', () => {
    backups.ensureToday(new Date(2026, 10, 1, 9));
    backups.ensureToday(new Date(2026, 10, 1, 18));
    assert.deepEqual(files(), ['afterglow-daily-2026-11-01.json']);
    for (let day = 2; day <= 20; day++) backups.ensureToday(new Date(2026, 10, day, 3));
    assert.equal(files().length, 14);
    assert.equal(files()[0], 'afterglow-daily-2026-11-07.json');
    assert.equal(files().at(-1), 'afterglow-daily-2026-11-20.json');
    const newest = backups.list()[0];
    assert.equal(newest.name, 'afterglow-daily-2026-11-20.json');
    assert.deepEqual([newest.kind, newest.zones, newest.schedules], ['daily', 1, 1]);
    assert.ok(newest.looks >= 13);
  });

  it('restores looks, zones, schedules, settings and light details', async () => {
    const snapshot = backups.snapshot('manual');
    const lookId = store.data.looks.find((l) => l.name === 'Mine')!.id;
    const light = hub.list().find((d) => d.name === 'Walkway A')!.id;

    // Wreck the setup.
    ops.deleteSchedule(store.data.schedules[0].id);
    ops.deleteLook(lookId);
    ops.deleteGroup(store.data.groups[0].id);
    ops.updateSettings({ location: null, swatches: [], catchUp: true });
    hub.update(light, { name: 'Wrong', reversed: false });
    hub.setOrder([]);
    ops.saveLook({ name: 'Made after the backup', colors: [0xffffff], pattern: 'solid', brightness: null });

    const before = restored;
    const counts = backups.restore(backups.read(snapshot.name));
    assert.deepEqual([counts.zones, counts.schedules], [1, 1]);
    assert.equal(restored, before + 1, 'open pages are told to refresh');

    assert.ok(store.data.looks.some((l) => l.id === lookId && l.name === 'Mine'));
    assert.ok(!store.data.looks.some((l) => l.name === 'Made after the backup'), 'a restore replaces, it does not merge');
    assert.deepEqual(store.data.groups.map((g) => [g.name, g.joined]), [['Right walkway', true]]);
    const schedule = store.data.schedules[0];
    assert.equal(schedule.name, 'Evening');
    assert.deepEqual(schedule.action, { type: 'look', lookId });
    assert.ok(Date.now() - schedule.lastStart! < 5_000, 'a restored schedule does not fire for a time already past today');
    assert.equal(store.data.settings.location?.label, 'Home');
    assert.deepEqual(store.data.settings.swatches, [0x123456]);
    assert.equal(store.data.settings.catchUp, false, 'the catch-up switch is part of the setup');
    const restoredLight = hub.list().find((d) => d.id === light)!;
    assert.deepEqual([restoredLight.name, restoredLight.reversed], ['Walkway A', true]);
    assert.equal(hub.list()[0].goveeName, 'Driveway rope', 'the order of lights comes back too');
    assert.equal(store.data.activity[0].text.startsWith('Restored a backup from'), true);
  });

  it('snapshots the current setup first, so a restore can be undone', () => {
    const undo = backups.list().find((b) => b.kind === 'before-restore')!;
    assert.ok(undo, 'a before-restore snapshot exists');
    const doc = backups.read(undo.name) as { looks: { name: string }[] };
    assert.ok(doc.looks.some((l) => l.name === 'Made after the backup'));
  });

  it('stops movement in progress, since it belongs to the setup being replaced', async () => {
    const look = store.data.looks.find((l) => l.name === 'Mine')!;
    await (await hub.apply(['all'], { type: 'look', lookId: look.id }, 'app')).done;
    assert.ok(hub.list().some((d) => d.moving));
    backups.restore(backups.document());
    assert.equal(hub.list().some((d) => d.moving), false);
  });

  it('ignores lights in a backup that no longer exist', () => {
    const doc = backups.document();
    doc.lights.push({ id: 'gone', goveeName: 'Old light', name: 'Old', reversed: true });
    doc.order = ['gone', ...doc.order];
    assert.doesNotThrow(() => backups.restore(doc));
    assert.equal(hub.list().some((d) => d.id === 'gone'), false);
  });

  it('refuses files that are not backups, and names outside its folder', () => {
    const looksBefore = store.data.looks.length;
    const undoBefore = backups.list().filter((b) => b.kind === 'before-restore').length;
    assert.throws(() => backups.restore({ hello: 'world' }), /not an Afterglow backup/);
    assert.throws(() => backups.restore({ ...backups.document(), app: 'something-else' }), /not an Afterglow backup/);
    assert.throws(() => backups.restore({ ...backups.document(), looks: [{ id: 'x', name: 'Bad', colors: [], pattern: 'gradient' }] }), /not an Afterglow backup/);
    assert.equal(store.data.looks.length, looksBefore, 'a refused restore changes nothing');
    assert.equal(backups.list().filter((b) => b.kind === 'before-restore').length, undoBefore, '…and does not even take a snapshot');
    assert.throws(() => backups.read('../afterglow.json'), /No such backup/);
    assert.throws(() => backups.read('afterglow-daily-1999-01-01.json'), /No such backup/);
  });

  it('keeps only a handful of manual and before-restore snapshots', () => {
    for (let i = 0; i < 8; i++) backups.snapshot('manual', new Date(2026, 10, 21, 10, i));
    const others = backups.list().filter((b) => b.kind !== 'daily');
    assert.equal(others.length, 5);
    assert.equal(backups.list().filter((b) => b.kind === 'daily').length, 14);
  });
});
