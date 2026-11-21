import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BackupInfo } from '../shared/types';
import { HttpError, type Hub } from './hub';
import { groupSchema, lookSchema, scheduleSchema } from './ops';
import type { Store } from './store';

/**
 * Backups of everything the user has made: looks, zones, schedules, settings, and how
 * the lights are named, ordered and oriented. A snapshot is written every day and the
 * last two weeks are kept; the same document can be downloaded and restored by hand.
 *
 * Deliberately left out: the Govee key and passphrase (they live in .env), and anything
 * that describes the moment rather than the setup (what the lights are showing, the
 * activity log, request counts).
 */

const DAILY_KEPT = 14;
const OTHER_KEPT = 5;

const rgb = z.number().int().min(0).max(0xffffff);

const documentSchema = z.object({
  app: z.literal('afterglow'),
  version: z.literal(1),
  createdAt: z.number(),
  looks: z.array(lookSchema.extend({ id: z.string().min(1), createdAt: z.number().optional(), updatedAt: z.number().optional() })).max(500),
  groups: z.array(groupSchema.extend({ id: z.string().min(1) })).max(200),
  schedules: z.array(scheduleSchema.extend({ id: z.string().min(1) })).max(200),
  settings: z.object({
    location: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), label: z.string().max(60).default('') }).nullable(),
    swatches: z.array(rgb).max(24),
  }),
  order: z.array(z.string()).max(500).default([]),
  seeded: z.array(z.string()).max(200).optional(),
  lights: z.array(z.object({ id: z.string(), goveeName: z.string().optional(), name: z.string().max(60).nullable(), reversed: z.boolean().default(false) })).max(500).default([]),
});

export type BackupDocument = z.infer<typeof documentSchema>;

const stamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clock = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('-');

export class Backups {
  constructor(
    private store: Store,
    private hub: Hub,
    private dir: string,
    /** Keeps demo snapshots apart from real ones. */
    private prefix: string,
    private onRestored: () => void,
  ) {}

  start(): void {
    this.ensureToday();
    setInterval(() => this.ensureToday(), 60 * 60_000).unref();
  }

  /** Everything worth keeping, as one document. */
  document(now = Date.now()): BackupDocument {
    const d = this.store.data;
    return {
      app: 'afterglow',
      version: 1,
      createdAt: now,
      looks: d.looks.map((l) => ({ ...l, brightness: l.brightness ?? null })),
      groups: d.groups,
      // When a schedule last ran belongs to the moment, not to the setup.
      schedules: d.schedules.map(({ lastStart, lastEnd, lastOff, ...rest }) => ({ ...rest, end: rest.end ?? null, season: rest.season ?? null })) as BackupDocument['schedules'],
      settings: d.settings,
      order: d.order,
      seeded: d.seeded,
      lights: this.hub.list().map((light) => ({ id: light.id, goveeName: light.goveeName, name: light.name === light.goveeName ? null : light.name, reversed: light.reversed })),
    };
  }

  private file(name: string): string {
    // Only names this class wrote are accepted, so a request cannot reach outside the folder.
    if (!this.parse(name)) throw new HttpError(404, 'No such backup');
    return path.join(this.dir, name);
  }

  private parse(name: string): { kind: BackupInfo['kind']; key: string } | null {
    const m = new RegExp(`^${this.prefix}-(daily|manual|before-restore)-(\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}-\\d{2}-\\d{2})?)\\.json$`).exec(name);
    return m ? { kind: m[1] as BackupInfo['kind'], key: m[2] } : null;
  }

  /** Writes a snapshot now. Daily ones are named for the day, so there is at most one per day. */
  snapshot(kind: BackupInfo['kind'], now = new Date()): BackupInfo {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = `${this.prefix}-${kind}-${kind === 'daily' ? stamp(now) : `${stamp(now)}T${clock(now)}`}.json`;
    const target = path.join(this.dir, name);
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(this.document(now.getTime()), null, 2));
    fs.renameSync(`${target}.tmp`, target);
    this.prune();
    return this.list().find((b) => b.name === name)!;
  }

  /** Makes today's snapshot if there is not one yet. */
  ensureToday(now = new Date()): void {
    try {
      if (!fs.existsSync(path.join(this.dir, `${this.prefix}-daily-${stamp(now)}.json`))) this.snapshot('daily', now);
    } catch (err) {
      console.error('Could not write the daily backup:', (err as Error).message);
    }
  }

  private prune(): void {
    const all = this.list();
    const extra = [...all.filter((b) => b.kind === 'daily').slice(DAILY_KEPT), ...all.filter((b) => b.kind !== 'daily').slice(OTHER_KEPT)];
    for (const old of extra) fs.rmSync(path.join(this.dir, old.name), { force: true });
  }

  /** Snapshots on disk, newest first. */
  list(): BackupInfo[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: BackupInfo[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      const parsed = this.parse(name);
      if (!parsed) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        out.push({ name, kind: parsed.kind, at: Number(doc.createdAt) || 0, looks: doc.looks?.length ?? 0, zones: doc.groups?.length ?? 0, schedules: doc.schedules?.length ?? 0 });
      } catch {
        // An unreadable file is no use as a backup; leave it out rather than fail the list.
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  read(name: string): unknown {
    const file = this.file(name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'No such backup');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /**
   * Replaces the current setup with a backup. A snapshot of the current setup is taken
   * first, so a restore can itself be undone.
   */
  restore(input: unknown): { looks: number; zones: number; schedules: number } {
    const parsed = documentSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'That file is not an Afterglow backup, or it is damaged');
    const doc = parsed.data;
    this.snapshot('before-restore');

    const d = this.store.data;
    const now = Date.now();
    d.looks = doc.looks.map((l) => ({ ...l, createdAt: l.createdAt ?? now, updatedAt: l.updatedAt ?? now }));
    d.groups = doc.groups;
    // Marked as just run, so a time that has already passed today does not fire on restore.
    d.schedules = doc.schedules.map((s) => ({ ...s, lastStart: now, lastEnd: now }));
    d.settings = doc.settings;
    // Starter looks removed before the backup was made should stay removed.
    d.seeded = [...new Set([...d.seeded, ...(doc.seeded ?? [])])];

    const known = new Set(this.hub.list().map((light) => light.id));
    for (const light of doc.lights) if (known.has(light.id)) this.hub.update(light.id, { name: light.name, reversed: light.reversed });
    this.hub.setOrder(doc.order);

    // Movement and turn-off checks in progress refer to the setup being replaced.
    this.hub.animator.release([...known]);
    d.watches = [];
    this.store.log({ source: 'app', ok: true, text: `Restored a backup from ${new Date(doc.createdAt).toLocaleString()}` });
    this.store.flush();
    this.onRestored();
    return { looks: doc.looks.length, zones: doc.groups.length, schedules: doc.schedules.length };
  }
}
