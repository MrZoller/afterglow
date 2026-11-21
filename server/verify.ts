import type { Action, Schedule } from '../shared/types';
import type { Hub } from './hub';
import type { Notice } from './notify';
import type { Store } from './store';

/**
 * Makes sure that what a schedule did really happened. After a schedule starts or ends,
 * each light is asked whether it obeyed; any that did not, or cannot be reached, is sent
 * the same thing again, at widening intervals for an hour. The outcome is recorded on the
 * schedule and in the activity log, and a phone notification goes out for lights that are
 * still not right after ten minutes.
 *
 * Lights that are still not right after the hour are tried every few minutes for the
 * rest of the day, so one that comes back after a power cut or a Wi-Fi drop is brought
 * into line then ("catching up").
 *
 * A light is dropped the moment anything else is applied to it, so this never fights
 * someone who has used the light since.
 */

/** Minutes after the schedule ran at which the lights are checked. */
export const CHECK_MINUTES = [1, 3, 10, 30, 60];
/** After those, how often the lights still not right are tried again… */
export const LATE_EVERY_MINUTES = 10;
/** …and for how long after the schedule ran. */
export const CATCH_UP_HOURS = 24;
/** A notification goes out about lights still not right after this many checks: the ten-minute one. */
const ALERT_AFTER_CHECKS = 3;

const MIN = 60_000;

export interface Watch {
  id: string;
  scheduleId: string;
  label: string;
  /** What the schedule did: `start` applied its action, `end` switched the lights off. Watches saved before starts were followed have none, and are ends. */
  kind?: 'start' | 'end';
  startedAt: number;
  /** How many checks have been made. */
  check: number;
  /** Lights not yet seen to have obeyed. */
  lights: string[];
  /** Lights that had to be sent their orders again. */
  retried: string[];
  /** Lights still not right when last looked at. */
  missing?: string[];
  /** Lights whose last orders could not be sent at all. */
  unsent?: string[];
  /** Lights a notification has gone out about. */
  alerted?: string[];
  /** Set once the timed checks are over: when the lights still not right are next tried, and when to stop. */
  nextAt?: number;
  until?: number;
}

interface Seen {
  id: string;
  power: boolean | null;
  reachable: boolean;
}

const OFF: Action = { type: 'power', on: false };

const list = (names: string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const capital = (text: string) => text[0].toUpperCase() + text.slice(1);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** "25 minutes", "3 hours": how long something took, to the nearest sensible unit. */
export function howLong(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MIN));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours`;
}

/** Whether an action leaves a light on or off, or null when it does not say. */
export function powerAfter(action: Action): boolean | null {
  if (action.type === 'power') return action.on;
  return ['color', 'colorTemp', 'segments', 'scene', 'look', 'palette'].includes(action.type) ? true : null;
}

export class Watcher {
  /** Pause after resending before reading the light again. */
  settleMs = 4_000;
  /** Shrinks every wait. Only the browser tests change it. */
  scale = 1;

  private busy = false;

  constructor(
    private store: Store,
    private hub: Hub,
    private onChange: () => void,
    private notify: (notice: Notice) => void = () => undefined,
  ) {
    // Someone using a light takes it out of any check: their wishes are newer than the schedule's.
    hub.on('applied', (ids: string[]) => this.release(ids));
  }

  start(): void {
    setInterval(() => void this.tick(), Math.max(1_000, 15_000 * this.scale)).unref();
  }

  private get watches(): Watch[] {
    return this.store.data.watches;
  }

  private get catchUp(): boolean {
    return this.store.data.settings.catchUp !== false;
  }

  /** True during the hour after a schedule switched lights off, while they are being checked. */
  checking(scheduleId: string): boolean {
    return this.watches.some((w) => w.scheduleId === scheduleId && (w.kind ?? 'end') === 'end' && w.nextAt === undefined);
  }

  /** Lights that missed what a schedule last did and are still being tried. */
  catchingUp(scheduleId: string): { kind: 'start' | 'end'; lights: string[] } | null {
    for (const w of this.watches) {
      if (w.scheduleId !== scheduleId) continue;
      const waiting = (w.missing ?? []).filter((id) => w.lights.includes(id));
      if (waiting.length) return { kind: w.kind ?? 'end', lights: waiting.map((id) => this.hub.nameOf(id)) };
    }
    return null;
  }

  /** Begins checking that these lights did what the schedule asked. */
  watch(schedule: Pick<Schedule, 'id' | 'name'>, kind: 'start' | 'end', deviceIds: string[], now = Date.now()): Watch | null {
    if (deviceIds.length === 0) return null;
    this.release(deviceIds);
    const w: Watch = { id: crypto.randomUUID(), scheduleId: schedule.id, label: schedule.name, kind, startedAt: now, check: 0, lights: [...deviceIds], retried: [] };
    this.watches.push(w);
    this.store.save();
    this.onChange();
    return w;
  }

  /** Records lights whose orders could not be sent, so they are sent again at the first check even if they look right. */
  unsent(w: Watch, deviceIds: string[]): void {
    if (!this.watches.includes(w) || deviceIds.length === 0) return;
    w.unsent = deviceIds.filter((id) => w.lights.includes(id));
    w.missing = [...new Set([...(w.missing ?? []), ...w.unsent])];
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

  private remove(w: Watch): void {
    this.store.data.watches = this.watches.filter((x) => x !== w);
    this.store.save();
    this.onChange();
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const w of [...this.watches]) {
        const due = w.nextAt ?? w.startedAt + CHECK_MINUTES[w.check] * MIN * this.scale;
        if (now >= due) await this.check(w, now);
      }
    } finally {
      this.busy = false;
    }
  }

  /** What the watched lights should be doing, or null when the schedule has since been changed, paused or removed. */
  private wanted(w: Watch): { action: Action; power: boolean | null; targets?: string[] } | null {
    if ((w.kind ?? 'end') === 'end') return { action: OFF, power: false };
    const s = this.store.data.schedules.find((x) => x.id === w.scheduleId);
    // Saving, pausing or restoring a schedule stamps it afresh; what it did before no longer stands.
    if (!s || !s.enabled || s.lastStart !== w.startedAt) return null;
    if (s.action.type === 'look' && !this.store.data.looks.some((l) => l.id === (s.action as { lookId: string }).lookId)) return null;
    // Its targets are kept whole so that a light gets its own share of a design spread over several.
    return { action: s.action, power: powerAfter(s.action), targets: s.targets };
  }

  private read(ids: string[]): Promise<Seen[]> {
    return Promise.all(ids.map(async (id) => ({ id, ...(await this.hub.powerOf(id)) })));
  }

  private async check(w: Watch, now: number): Promise<void> {
    const want = this.wanted(w);
    if (!want) return this.remove(w);
    const right = (s: Seen) => s.reachable && (want.power === null || s.power === want.power) && !(w.unsent ?? []).includes(s.id);

    const seen = await this.read(w.lights);
    // Lights used by someone while we were asking have already left the watch.
    if (!this.watches.includes(w)) return;
    const watched = seen.filter((s) => w.lights.includes(s.id));
    this.cameRight(w, watched.filter(right), now);
    const wrong = watched.filter((s) => !right(s));
    if (wrong.length === 0) return this.finish(w, now);

    const ids = wrong.map((s) => s.id);
    let unsent: string[] = [];
    try {
      const result = await this.hub.apply(want.targets ?? ids, want.action, 'schedule', { internal: true, quiet: true, ...(want.targets ? { only: ids, since: w.startedAt } : {}) });
      unsent = (await result.done).failed.map((f) => f.deviceId);
    } catch {
      // The lights, or the look they were to show, no longer exist: nothing is left to follow up.
      return this.remove(w);
    }
    // Lights used by someone while the resend was going out have left the watch, and stay out of it.
    if (!this.watches.includes(w)) return;
    w.lights = ids.filter((id) => w.lights.includes(id));
    w.retried = [...new Set([...w.retried, ...ids])];
    w.unsent = unsent;
    w.check += 1;

    // Read the lights again so the app shows what they are really doing, not what was asked of them.
    await sleep(this.settleMs * Math.min(1, this.scale));
    const after = (await this.read(ids)).filter((s) => w.lights.includes(s.id));
    if (!this.watches.includes(w)) return;
    const stillWrong = after.filter((s) => !right(s));
    w.missing = stillWrong.map((s) => s.id);

    if (w.nextAt === undefined && w.check < CHECK_MINUTES.length) {
      // Normally the next check gives the verdict; a light that only now obeyed is confirmed then.
      if (w.check === ALERT_AFTER_CHECKS) this.alert(w, stillWrong);
      this.store.save();
      this.onChange();
      return;
    }

    // Past the timed checks, this reading has to decide.
    this.cameRight(w, after.filter(right), now);
    if (stillWrong.length === 0) return this.finish(w, now);
    w.lights = stillWrong.map((s) => s.id);
    if (w.nextAt === undefined) {
      this.report(w, now, stillWrong);
      if (!this.catchUp) return this.remove(w);
      w.until = w.startedAt + CATCH_UP_HOURS * 60 * MIN * this.scale;
    } else {
      // The failed resend left its own error on the light; say again what it means for the schedule.
      for (const [id, message] of this.problems(w, stillWrong).flags) this.hub.flag(id, message);
    }
    if (now >= (w.until ?? 0)) return this.giveUp(w);
    w.nextAt = now + LATE_EVERY_MINUTES * MIN * this.scale;
    this.store.save();
    this.onChange();
  }

  private names(ids: string[]): string {
    return list(ids.map((id) => this.hub.nameOf(id)));
  }

  /** What went wrong, in words: which lights are doing the wrong thing and which cannot be reached. */
  private problems(w: Watch, wrong: Seen[]): { text: string; flags: [string, string][] } {
    const end = (w.kind ?? 'end') === 'end';
    const there = wrong.filter((s) => s.reachable).map((s) => s.id);
    const silent = wrong.filter((s) => !s.reachable).map((s) => s.id);
    const verb = (ids: string[], one: string, many: string) => `${this.names(ids)} ${ids.length === 1 ? one : many}`;
    const parts = [
      ...(there.length ? [end ? verb(there, 'is still on', 'are still on') : verb(there, 'did not respond', 'did not respond')] : []),
      ...(silent.length ? [`${this.names(silent)} could not be reached`] : []),
    ];
    const did = end ? 'ended' : 'started';
    return {
      text: parts.join('; '),
      flags: [
        ...there.map((id): [string, string] => [id, end ? `Still on after “${w.label}” ended` : `Did not respond when “${w.label}” started`]),
        ...silent.map((id): [string, string] => [id, end ? `Could not be reached to confirm it is off after “${w.label}” ended` : `Could not be reached when “${w.label}” ${did}`]),
      ],
    };
  }

  /** Tells the owner's phone about lights that are still not right ten minutes on. */
  private alert(w: Watch, wrong: Seen[]): void {
    const fresh = wrong.filter((s) => !(w.alerted ?? []).includes(s.id));
    if (fresh.length === 0) return;
    const end = (w.kind ?? 'end') === 'end';
    w.alerted = [...(w.alerted ?? []), ...fresh.map((s) => s.id)];
    this.notify({
      title: end ? 'Lights still on' : 'Lights missed a schedule',
      text: `“${w.label}” ${end ? 'ended' : 'started'} at ${clock(w.startedAt)}, but ${this.problems(w, fresh).text}. Afterglow will keep trying.`,
      urgent: true,
    });
  }

  /** Lights seen to be right. Ones the owner was warned about, or that took more than the hour, get a mention. */
  private cameRight(w: Watch, seen: Seen[], now: number): void {
    const ids = seen.map((s) => s.id);
    if (ids.length === 0) return;
    const end = (w.kind ?? 'end') === 'end';
    const took = howLong(now - w.startedAt);
    const told = ids.filter((id) => (w.alerted ?? []).includes(id));
    if (told.length) {
      w.alerted = (w.alerted ?? []).filter((id) => !told.includes(id));
      this.notify({
        title: end ? 'Lights now off' : 'Lights caught up',
        text: end
          ? `${this.names(told)} ${told.length === 1 ? 'is' : 'are'} off now, ${took} after “${w.label}” ended.`
          : `${this.names(told)} ${told.length === 1 ? 'has' : 'have'} caught up with “${w.label}”, ${took} after it started.`,
      });
    }
    if (w.nextAt === undefined) return;
    // After the hour, each light that comes right is worth a line of its own.
    for (const id of ids) for (const [flagged, message] of this.problems(w, [{ id, power: null, reachable: true }, { id, power: null, reachable: false }]).flags) this.hub.unflag(flagged, message);
    this.store.log({ source: 'schedule', ok: true, text: end ? `${this.names(ids)} turned off ${took} after “${w.label}” ended` : `${this.names(ids)} caught up with “${w.label}” ${took} after it started` });
    this.hub.emit('activity');
  }

  /** Every light is right: the watch is over. */
  private finish(w: Watch, now: number): void {
    const end = (w.kind ?? 'end') === 'end';
    const schedule = this.store.data.schedules.find((s) => s.id === w.scheduleId);
    const retried = w.retried.map((id) => this.hub.nameOf(id));
    const again = retried.length ? `${list(retried)} needed another try` : undefined;

    if (w.nextAt !== undefined) {
      // The lights that took longest were logged as they came right.
      if (end && schedule) schedule.lastOff = { at: now, ok: true, text: `Confirmed off after ${howLong(now - w.startedAt)}` };
    } else if (end) {
      if (schedule) schedule.lastOff = { at: now, ok: true, text: again ? `Confirmed off (${again})` : 'Confirmed off' };
      this.store.log({ source: 'schedule', ok: true, text: `“${w.label}” ended: lights confirmed off`, detail: again });
    } else if (again) {
      this.store.log({ source: 'schedule', ok: true, text: `“${w.label}” started: ${again}` });
    }
    this.hub.emit('activity');
    this.remove(w);
  }

  /** The verdict after the last timed check, for the lights that are still not right. */
  private report(w: Watch, now: number, wrong: Seen[]): void {
    const end = (w.kind ?? 'end') === 'end';
    const schedule = this.store.data.schedules.find((s) => s.id === w.scheduleId);
    const { text, flags } = this.problems(w, wrong);
    if (end && schedule) schedule.lastOff = { at: now, ok: false, text: capital(text) };
    for (const [id, message] of flags) this.hub.flag(id, message);
    const checks = `after ${CHECK_MINUTES.length} checks over ${CHECK_MINUTES.at(-1)} minutes`;
    this.store.log({
      source: 'schedule',
      ok: false,
      text: `“${w.label}” ${end ? 'ended' : 'started'}, but ${text}`,
      detail: this.catchUp ? `${checks}; still trying every ${LATE_EVERY_MINUTES} minutes` : checks,
    });
    this.hub.emit('activity');
  }

  private giveUp(w: Watch): void {
    const end = (w.kind ?? 'end') === 'end';
    this.store.log({
      source: 'schedule',
      ok: false,
      text: `Stopped trying to ${end ? 'turn off' : 'bring in'} ${this.names(w.lights)} after “${w.label}” ${end ? 'ended' : 'started'}`,
      detail: `no luck in ${CATCH_UP_HOURS} hours`,
    });
    this.hub.emit('activity');
    this.remove(w);
  }
}
