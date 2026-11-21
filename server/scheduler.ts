import { getTimes } from 'suncalc';
import type { Action, Schedule, ScheduleView, Settings, TimeSpec } from '../shared/types';
import type { Hub } from './hub';
import type { Notice } from './notify';
import type { Store } from './store';
import { CATCH_UP_HOURS, howLong, Watcher } from './verify';

type Location = Settings['location'];

/** A run that came due this recently is carried out as if on time. */
const GRACE_MS = 10 * 60_000;
/** One missed by more than that (the app was not running, or the computer was asleep) is carried out late, if it is no older than this. */
const CATCH_UP_MS = CATCH_UP_HOURS * 60 * 60_000;

const dayStart = (d: Date, offsetDays = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays);

export function sunTimes(day: Date, loc: NonNullable<Location>): { sunrise: Date; sunset: Date } | null {
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  // Passing the UTC offset pins the result to this calendar day in the local timezone.
  const t = getTimes(noon, loc.lat, loc.lon, 0, -noon.getTimezoneOffset());
  // Near the poles the sun may not rise or set at all on a given day.
  if (!t.sunrise || !t.sunset) return null;
  return { sunrise: t.sunrise, sunset: t.sunset };
}

/** The moment a time spec refers to on a given local day, or null if it cannot be worked out. */
export function resolveTime(spec: TimeSpec, day: Date, loc: Location): Date | null {
  if (spec.type === 'clock') {
    const [h, m] = spec.time.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
  }
  if (!loc) return null;
  const sun = sunTimes(day, loc);
  if (!sun) return null;
  return new Date(sun[spec.event].getTime() + spec.offsetMin * 60_000);
}

export function inSeason(season: Schedule['season'], day: Date): boolean {
  if (!season) return true;
  const key = `${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  return season.from <= season.to ? key >= season.from && key <= season.to : key >= season.from || key <= season.to;
}

/** Start and end of the run that begins on `day`, or null if the schedule does not run that day. */
export function occurrence(s: Schedule, day: Date, loc: Location): { start: Date; end: Date | null } | null {
  if (!s.days.includes(day.getDay()) || !inSeason(s.season, day)) return null;
  const start = resolveTime(s.start, day, loc);
  if (!start) return null;
  let end = s.end ? resolveTime(s.end, day, loc) : null;
  // An end time earlier than the start means "the following morning".
  if (s.end && end && end <= start) end = resolveTime(s.end, dayStart(day, 1), loc);
  return { start, end };
}

export function nextEvent(s: Schedule, now: Date, loc: Location): ScheduleView['next'] {
  let best: ScheduleView['next'] = null;
  let foundOn: number | null = null;
  for (let offset = -1; offset <= 370; offset++) {
    // One extra day after the first hit covers an end time that lands after the next start.
    if (foundOn !== null && offset > foundOn + 1) break;
    const occ = occurrence(s, dayStart(now, offset), loc);
    if (!occ) continue;
    const candidates = [
      { at: occ.start.getTime(), kind: 'start' as const },
      ...(occ.end ? [{ at: occ.end.getTime(), kind: 'end' as const }] : []),
    ];
    for (const c of candidates) {
      if (c.at > now.getTime() && (!best || c.at < best.at)) {
        best = c;
        foundOn ??= offset;
      }
    }
  }
  return best;
}

const usesSun = (s: Schedule) => s.start.type === 'sun' || s.end?.type === 'sun';

const OFF: Action = { type: 'power', on: false };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Something a schedule did, or should have done, at a moment in the last day. */
interface Run {
  s: Schedule;
  kind: 'start' | 'end';
  at: number;
  /** Whether it was carried out. */
  done: boolean;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  /** Checks that what a schedule did really happened, and keeps trying lights that missed it. */
  readonly watcher: Watcher;

  /** When each light was last given orders, so that a late run never undoes something newer. */
  private touched = new Map<string, number>();

  constructor(
    private store: Store,
    private hub: Hub,
    private onChange: () => void,
    private notify: (notice: Notice) => void = () => undefined,
  ) {
    this.watcher = new Watcher(store, hub, onChange, notify);
    hub.on('applied', (ids: string[]) => {
      const now = Date.now();
      for (const id of ids) this.touched.set(id, now);
    });
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.timer.unref();
    void this.tick();
    this.watcher.start();
  }

  view(s: Schedule, now = new Date()): ScheduleView {
    const loc = this.store.data.settings.location;
    let problem: string | null = null;
    if (usesSun(s) && !loc) problem = 'Set your location in Settings to use sunrise and sunset times';
    else if (this.hub.deviceIds(s.targets).length === 0) problem = 'None of the selected lights exist any more';
    else if (s.action.type === 'look' && !this.store.data.looks.some((l) => l.id === (s.action as { lookId: string }).lookId)) problem = 'The look this schedule used was deleted';
    return { ...s, next: s.enabled && !problem ? nextEvent(s, now, loc) : null, problem, checkingOff: this.watcher.checking(s.id), catchingUp: this.watcher.catchingUp(s.id) };
  }

  views(): ScheduleView[] {
    const now = new Date();
    return this.store.data.schedules.map((s) => this.view(s, now));
  }

  /**
   * Carries out everything that came due since the last tick. Runs that were missed
   * altogether, because the app was not running or the computer was asleep, are carried
   * out late: each light gets whatever the schedules last said it should be doing.
   */
  async tick(now = new Date()): Promise<void> {
    const loc = this.store.data.settings.location;
    const t = now.getTime();
    const catchUp = this.store.data.settings.catchUp !== false;

    // Everything the schedules did, or should have done, in the last day.
    const runs: Run[] = [];
    for (const s of this.store.data.schedules) {
      if (!s.enabled) continue;
      for (const offset of [-2, -1, 0]) {
        const occ = occurrence(s, dayStart(now, offset), loc);
        if (!occ) continue;
        const add = (kind: Run['kind'], at: Date | null, last: number | null) => {
          if (!at || at.getTime() > t || t - at.getTime() > CATCH_UP_MS) return;
          runs.push({ s, kind, at: at.getTime(), done: (last ?? 0) >= at.getTime() });
        };
        add('start', occ.start, s.lastStart);
        add('end', occ.end, s.lastEnd);
      }
    }
    // In the order they happened. At the same moment ends go first so a schedule starting
    // then wins, and seasonal schedules go last so they win over everyday ones.
    runs.sort((a, b) => a.at - b.at || Number(a.kind === 'start') - Number(b.kind === 'start') || Number(!!a.s.season) - Number(!!b.s.season));

    const late = (r: Run) => t - r.at > GRACE_MS;
    const todo = runs.filter((r) => !r.done && (catchUp || !late(r)));
    if (todo.length === 0) return;

    // What a light should be doing now is whatever the schedules did to it last.
    const latest = new Map<string, Run>();
    for (const r of runs) for (const id of this.hub.deviceIds(r.s.targets)) latest.set(id, r);

    for (const r of todo) {
      if (r.kind === 'start') r.s.lastStart = t;
      else r.s.lastEnd = t;
    }
    this.store.save();

    for (const r of todo) {
      const all = this.hub.deviceIds(r.s.targets);
      // A late run leaves alone any light that has been given something else since.
      const ids = all.filter((id) => latest.get(id) === r && !(late(r) && (this.touched.get(id) ?? 0) > r.at));
      if (ids.length) await this.run(r, ids, ids.length < all.length, t);
    }
    this.onChange();
  }

  private async run(r: Run, ids: string[], partial: boolean, t: number): Promise<void> {
    const { s, kind } = r;
    const action = kind === 'end' ? OFF : s.action;
    try {
      // Not waiting for delivery: each light's queue keeps the commands in order.
      const { summary, done } = await this.hub.apply(s.targets, action, 'schedule', partial ? { only: ids } : {});
      // What it did is then checked, and repeated for any light that did not obey.
      const off = action.type === 'power' && !action.on;
      const watch = this.watcher.watch(s, off ? 'end' : 'start', summary.applied, t);
      if (watch && !off) void done.then(({ failed }) => this.watcher.unsent(watch, failed.map((f) => f.deviceId)));
      if (t - r.at > GRACE_MS && summary.applied.length) this.ranLate(r, t);
    } catch (err) {
      this.store.log({ source: 'schedule', ok: false, text: `Schedule "${s.name}" could not run`, detail: (err as Error).message });
      this.hub.emit('activity');
    }
  }

  private ranLate(r: Run, t: number): void {
    const end = r.kind === 'end';
    const why = `Afterglow was not running, or this computer was asleep, at ${clock(r.at)}`;
    this.store.log({ source: 'schedule', ok: true, text: `“${r.s.name}” ${end ? 'ended' : 'started'} ${howLong(t - r.at)} late`, detail: why });
    this.hub.emit('activity');
    this.notify({
      title: 'Schedule ran late',
      text: end ? `${why}, when “${r.s.name}” should have switched the lights off. They were switched off at ${clock(t)}.` : `${why}, when “${r.s.name}” should have started. It started at ${clock(t)}.`,
    });
  }
}
