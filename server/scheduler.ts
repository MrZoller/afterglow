import { getTimes } from 'suncalc';
import type { Schedule, ScheduleView, Settings, TimeSpec } from '../shared/types';
import type { Hub } from './hub';
import type { Store } from './store';

type Location = Settings['location'];

/** A schedule that should have fired while the app was not running still fires if it is this recent. */
const GRACE_MS = 10 * 60_000;

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

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private hub: Hub,
    private onChange: () => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 20_000);
    this.timer.unref();
    void this.tick();
  }

  view(s: Schedule, now = new Date()): ScheduleView {
    const loc = this.store.data.settings.location;
    let problem: string | null = null;
    if (usesSun(s) && !loc) problem = 'Set your location in Settings to use sunrise and sunset times';
    else if (this.hub.deviceIds(s.targets).length === 0) problem = 'None of the selected lights exist any more';
    else if (s.action.type === 'look' && !this.store.data.looks.some((l) => l.id === (s.action as { lookId: string }).lookId)) problem = 'The look this schedule used was deleted';
    return { ...s, next: s.enabled && !problem ? nextEvent(s, now, loc) : null, problem };
  }

  views(): ScheduleView[] {
    const now = new Date();
    return this.store.data.schedules.map((s) => this.view(s, now));
  }

  /** Fires everything that came due since the last tick. */
  async tick(now = new Date()): Promise<void> {
    const loc = this.store.data.settings.location;
    const due: { s: Schedule; kind: 'start' | 'end' }[] = [];

    for (const s of this.store.data.schedules) {
      if (!s.enabled) continue;
      for (const offset of [-1, 0]) {
        const occ = occurrence(s, dayStart(now, offset), loc);
        if (!occ) continue;
        const isDue = (at: Date | null, last: number | null) =>
          !!at && at.getTime() <= now.getTime() && now.getTime() - at.getTime() <= GRACE_MS && (last ?? 0) < at.getTime();
        if (isDue(occ.start, s.lastStart)) {
          s.lastStart = now.getTime();
          due.push({ s, kind: 'start' });
        }
        if (isDue(occ.end, s.lastEnd)) {
          s.lastEnd = now.getTime();
          due.push({ s, kind: 'end' });
        }
      }
    }
    if (due.length === 0) return;

    // Ends go first so a schedule starting at the same minute wins, and seasonal
    // schedules go last so they win over everyday ones.
    due.sort((a, b) => Number(a.kind === 'start') - Number(b.kind === 'start') || Number(!!a.s.season) - Number(!!b.s.season));
    this.store.save();

    for (const { s, kind } of due) {
      try {
        const action = kind === 'end' ? ({ type: 'power', on: false } as const) : s.action;
        // Not waiting for delivery: each light's queue keeps the commands in order.
        await this.hub.apply(s.targets, action, 'schedule');
      } catch (err) {
        this.store.log({ source: 'schedule', ok: false, text: `Schedule "${s.name}" could not run`, detail: (err as Error).message });
        this.hub.emit('activity');
      }
    }
    this.onChange();
  }
}
