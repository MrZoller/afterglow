import type { Schedule } from '../shared/types';
import type { Hub } from './hub';
import type { Store } from './store';

/**
 * Makes sure a scheduled turn-off really happened. After a schedule switches lights off,
 * each light is asked whether it is off; any that is still on, or cannot be reached, is
 * sent "off" again, at widening intervals for up to an hour. The outcome is recorded on
 * the schedule and in the activity log.
 *
 * A light is only watched until it is first seen to be off, and is dropped the moment
 * anything else is applied to it, so this never fights someone who turns a light back on.
 */

/** Minutes after the turn-off at which the lights are checked. */
export const CHECK_MINUTES = [1, 3, 10, 30, 60];

export interface OffWatch {
  id: string;
  scheduleId: string;
  label: string;
  startedAt: number;
  /** Index into CHECK_MINUTES of the next check. */
  check: number;
  /** Lights not yet seen to be off. */
  lights: string[];
  /** Lights that had to be sent "off" again. */
  retried: string[];
}

const list = (names: string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

export class OffWatcher {
  /** Pause after resending "off" before reading the light again. */
  settleMs = 4_000;

  private busy = false;

  constructor(
    private store: Store,
    private hub: Hub,
    private onChange: () => void,
  ) {
    // Someone using a light takes it out of any check: their wishes are newer than the schedule's.
    hub.on('applied', (ids: string[]) => this.release(ids));
  }

  start(): void {
    setInterval(() => void this.tick(), 15_000).unref();
  }

  private get watches(): OffWatch[] {
    return this.store.data.watches;
  }

  checking(scheduleId: string): boolean {
    return this.watches.some((w) => w.scheduleId === scheduleId);
  }

  /** Begins checking that these lights go off. */
  watch(schedule: Pick<Schedule, 'id' | 'name'>, deviceIds: string[], now = Date.now()): void {
    if (deviceIds.length === 0) return;
    this.release(deviceIds);
    this.watches.push({ id: crypto.randomUUID(), scheduleId: schedule.id, label: schedule.name, startedAt: now, check: 0, lights: [...deviceIds], retried: [] });
    this.store.save();
    this.onChange();
  }

  private release(deviceIds: string[]): void {
    const ids = new Set(deviceIds);
    let changed = false;
    for (const w of this.watches) {
      const kept = w.lights.filter((id) => !ids.has(id));
      if (kept.length !== w.lights.length) {
        w.lights = kept;
        changed = true;
      }
    }
    if (!changed) return;
    this.store.data.watches = this.watches.filter((w) => w.lights.length > 0);
    this.store.save();
    this.onChange();
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const w of [...this.watches]) {
        if (now >= w.startedAt + CHECK_MINUTES[w.check] * 60_000) await this.check(w, now);
      }
    } finally {
      this.busy = false;
    }
  }

  private async check(w: OffWatch, now: number): Promise<void> {
    const seen = await Promise.all(w.lights.map(async (id) => ({ id, ...(await this.hub.powerOf(id)) })));
    // Lights used by someone while we were asking have already left the watch.
    const watched = new Set(w.lights);
    const still = seen.filter((s) => watched.has(s.id) && !(s.reachable && s.power === false));
    if (!this.watches.includes(w)) return;
    if (still.length === 0) return this.finish(w, now, []);

    const ids = still.map((s) => s.id);
    try {
      const result = await this.hub.apply(ids, { type: 'power', on: false }, 'schedule', { internal: true, quiet: true });
      await result.done;
    } catch {
      // Nothing left to send to (the lights were removed); the next check reports it.
    }
    w.lights = ids;
    w.retried = [...new Set([...w.retried, ...ids])];
    w.check += 1;

    // Read the lights again so the app shows what they are really doing, not what was asked of them.
    await new Promise((r) => setTimeout(r, this.settleMs));
    const after = await Promise.all(ids.map(async (id) => ({ id, ...(await this.hub.powerOf(id)) })));
    if (!this.watches.includes(w)) return;
    // Normally the next check gives the verdict; after the last one, this reading has to.
    if (w.check >= CHECK_MINUTES.length) return this.finish(w, now, after.filter((s) => w.lights.includes(s.id) && !(s.reachable && s.power === false)));
    this.store.save();
  }

  private finish(w: OffWatch, now: number, failed: { id: string; power: boolean | null; reachable: boolean }[]): void {
    this.store.data.watches = this.watches.filter((x) => x !== w);
    const schedule = this.store.data.schedules.find((s) => s.id === w.scheduleId);
    const name = (id: string) => this.hub.nameOf(id);

    if (failed.length === 0) {
      const retried = w.retried.map(name);
      const text = retried.length ? `Confirmed off (${list(retried)} needed another try)` : 'Confirmed off';
      if (schedule) schedule.lastOff = { at: now, ok: true, text };
      this.store.log({ source: 'schedule', ok: true, text: `“${w.label}” ended: lights confirmed off`, detail: retried.length ? `${list(retried)} needed another try` : undefined });
    } else {
      const on = failed.filter((f) => f.reachable).map((f) => f.id);
      const silent = failed.filter((f) => !f.reachable).map((f) => f.id);
      const parts = [
        ...(on.length ? [`${list(on.map(name))} ${on.length === 1 ? 'is' : 'are'} still on`] : []),
        ...(silent.length ? [`${list(silent.map(name))} could not be reached`] : []),
      ];
      const text = parts.join('; ');
      if (schedule) schedule.lastOff = { at: now, ok: false, text: text[0].toUpperCase() + text.slice(1) };
      for (const id of on) this.hub.flag(id, `Still on after “${w.label}” ended`);
      for (const id of silent) this.hub.flag(id, `Could not be reached to confirm it is off after “${w.label}” ended`);
      this.store.log({ source: 'schedule', ok: false, text: `“${w.label}” ended, but ${text}`, detail: `after ${CHECK_MINUTES.length} checks over ${CHECK_MINUTES.at(-1)} minutes` });
    }
    this.store.save();
    this.hub.emit('activity');
    this.onChange();
  }
}
