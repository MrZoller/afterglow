import { kelvinToRgb, toHex } from '../../shared/color';
import type { Action, Device, Look, RGB, Schedule, ScheduleView, Snapshot, TimeSpec } from '../../shared/types';

export const MODEL_NAMES: Record<string, string> = { rope: 'Neon rope', garden: 'Garden lights', light: 'Light' };

/** Colours to draw for a light, one per segment where known. */
export function deviceColors(d: Device): RGB[] {
  const a = d.state.appearance;
  if (a.mode === 'color') return [a.rgb];
  if (a.mode === 'temp') return [kelvinToRgb(a.kelvin)];
  if (a.mode === 'segments') return a.colors;
  return [];
}

export function describeAppearance(d: Device, looks: Look[]): string {
  if (d.state.online === false) return 'Offline';
  if (d.state.power === false) return 'Off';
  const look = d.state.lookId ? looks.find((l) => l.id === d.state.lookId) : undefined;
  if (look) return look.name;
  const a = d.state.appearance;
  if (a.mode === 'scene') return a.scene.name;
  if (a.mode === 'temp') return `White ${a.kelvin}K`;
  if (a.mode === 'segments') return 'Painted';
  if (a.mode === 'color') return toHex(a.rgb).toUpperCase();
  return d.state.power ? 'On' : 'Unknown';
}

export const formatClock = (at: number | Date) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function clockLabel(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return formatClock(new Date(2000, 0, 1, h, m));
}

export function describeTime(spec: TimeSpec): string {
  if (spec.type === 'clock') return clockLabel(spec.time);
  const event = spec.event === 'sunset' ? 'Sunset' : 'Sunrise';
  if (!spec.offsetMin) return event;
  return `${Math.abs(spec.offsetMin)} min ${spec.offsetMin < 0 ? 'before' : 'after'} ${event.toLowerCase()}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function describeDays(days: number[]): string {
  const set = [...new Set(days)].sort();
  const key = set.join('');
  if (key === '0123456') return 'Every day';
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  return set.map((d) => DAY_NAMES[d]).join(', ');
}

export function describeSeason(season: Schedule['season']): string | null {
  if (!season) return null;
  const fmt = (md: string) => {
    const [m, d] = md.split('-').map(Number);
    return new Date(2000, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  return `${fmt(season.from)} – ${fmt(season.to)}`;
}

export function describeNext(next: ScheduleView['next']): string | null {
  if (!next) return null;
  const at = new Date(next.at);
  const today = new Date();
  const dayDiff = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000);
  const day = dayDiff === 0 ? 'today' : dayDiff === 1 ? 'tomorrow' : at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${next.kind === 'end' ? 'Turns off' : 'Starts'} ${day} at ${formatClock(at)}`;
}

export function describeAction(action: Action, snap: Snapshot): string {
  switch (action.type) {
    case 'power':
      return action.on ? 'Turn on' : 'Turn off';
    case 'brightness':
      return `Brightness ${action.value}%`;
    case 'color':
      return `Colour ${toHex(action.rgb).toUpperCase()}`;
    case 'colorTemp':
      return `White ${action.kelvin}K`;
    case 'look':
      return snap.looks.find((l) => l.id === action.lookId)?.name ?? 'Deleted look';
    case 'scene':
      return `${action.scene.name} scene`;
    default:
      return 'Custom';
  }
}

export function describeTargets(targets: string[], snap: Snapshot): string {
  if (targets.includes('all')) return 'All lights';
  const names = targets
    .map((t) => (t.startsWith('group:') ? snap.groups.find((g) => g.id === t.slice(6))?.name : snap.devices.find((d) => d.id === t)?.name))
    .filter((n): n is string => !!n);
  if (names.length === 0) return 'No lights';
  return names.length <= 2 ? names.join(' & ') : `${names[0]}, ${names[1]} +${names.length - 2}`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
