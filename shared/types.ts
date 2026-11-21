/** Types shared by the server and the web app. */

/** A colour packed as 0xRRGGBB. */
export type RGB = number;

export type SceneKind = 'light' | 'diy' | 'snapshot';

/** Scenes are referenced by name because their ids differ between models. */
export interface SceneRef {
  kind: SceneKind;
  name: string;
}

export interface SceneChoice extends SceneRef {
  /** How many of the requested lights offer this scene. */
  supported: number;
}

export interface DeviceCaps {
  power: boolean;
  brightness: { min: number; max: number } | null;
  color: boolean;
  colorTemp: { min: number; max: number } | null;
  /** Number of individually colourable segments; 0 when the light is one colour only. */
  segments: number;
  /** Extra on/off switches the light offers, e.g. gradientToggle. */
  toggles: string[];
}

export type Appearance =
  | { mode: 'color'; rgb: RGB }
  | { mode: 'temp'; kelvin: number }
  | { mode: 'segments'; colors: RGB[] }
  | { mode: 'scene'; scene: SceneRef }
  | { mode: 'unknown' };

export interface DeviceState {
  online: boolean | null;
  power: boolean | null;
  brightness: number | null;
  appearance: Appearance;
  /** The saved look last applied, if the light still shows it. */
  lookId: string | null;
  updatedAt: number;
  /** Last time the state was read back from Govee. */
  syncedAt: number | null;
}

export type DeviceKind = 'rope' | 'garden' | 'light';

export interface Device {
  id: string;
  sku: string;
  /** Name shown in the app: the alias if set, else the Govee name. */
  name: string;
  goveeName: string;
  kind: DeviceKind;
  caps: DeviceCaps;
  state: DeviceState;
  /** True while a moving look is slowly changing this light's colours. */
  moving: boolean;
  /** True when the light answers on the local network, so simple commands skip Govee's cloud. */
  local: boolean;
  /** True when the light is mounted with its last segment where designs should start. */
  reversed: boolean;
  /** Commands waiting to be sent. */
  pending: number;
  error: string | null;
}

export interface Group {
  id: string;
  name: string;
  /** In order: for joined lights, the first is where the run starts. */
  deviceIds: string[];
  /**
   * True when the lights are mounted end to end and should behave as one long light.
   * Looks, painting and movement then run across all of them in order.
   */
  joined?: boolean;
}

export type LookPattern = 'solid' | 'perLight' | 'gradient' | 'blocks' | 'alternate' | 'custom';

export interface Look {
  id: string;
  name: string;
  /** Palette, 1 to 8 colours. */
  colors: RGB[];
  pattern: LookPattern;
  /** For the `custom` pattern: hand-painted colours, resampled to each light's segment count. */
  segments?: RGB[];
  brightness: number | null;
  /** When set, the colours slowly move through the palette, one full trip per `loopMinutes`. */
  motion?: Motion | null;
  createdAt: number;
  updatedAt: number;
}

export interface Motion {
  loopMinutes: number;
}

export type Action =
  | { type: 'power'; on: boolean }
  | { type: 'brightness'; value: number }
  | { type: 'color'; rgb: RGB }
  | { type: 'colorTemp'; kelvin: number }
  | { type: 'segments'; colors: RGB[] }
  | { type: 'scene'; scene: SceneRef }
  | { type: 'look'; lookId: string }
  /** A look that has not been saved, used to try a design while editing it. */
  | { type: 'palette'; colors: RGB[]; pattern: LookPattern; segments?: RGB[]; brightness: number | null; motion?: Motion | null }
  /** Stops a moving look where it is, keeping the colours currently showing. */
  | { type: 'still' }
  | { type: 'toggle'; instance: string; on: boolean };

/** A look proposed by the assistant, not yet saved. */
export interface LookIdea {
  name: string;
  colors: RGB[];
  pattern: LookPattern;
  segments?: RGB[];
  brightness: number | null;
  motion?: Motion | null;
  note: string;
}

export interface LookSuggestions {
  ideas: LookIdea[];
  /** Built-in animated scenes that fit the request. */
  scenes: SceneRef[];
}

export type TimeSpec =
  | { type: 'clock'; time: string } // "HH:MM", 24h, local time
  | { type: 'sun'; event: 'sunrise' | 'sunset'; offsetMin: number };

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  /** Days of week the schedule starts on. 0 = Sunday. */
  days: number[];
  start: TimeSpec;
  /** When set, the targets are switched off at this time (next day if earlier than start). */
  end: TimeSpec | null;
  /** Optional yearly date range, "MM-DD" inclusive; may wrap the new year. */
  season: { from: string; to: string } | null;
  /** "all", "group:<id>" or a device id. */
  targets: string[];
  action: Action;
  lastStart: number | null;
  lastEnd: number | null;
  /** Outcome of checking that the lights really went off the last time this schedule turned them off. */
  lastOff?: { at: number; ok: boolean; text: string } | null;
}

export interface ScheduleView extends Schedule {
  next: { at: number; kind: 'start' | 'end' } | null;
  /** True while the lights are still being checked after a turn-off. */
  checkingOff: boolean;
  /** Why the schedule cannot run, e.g. a sun time without a location. */
  problem: string | null;
}

export interface Settings {
  location: { lat: number; lon: number; label: string } | null;
  /** Colours saved from the picker. */
  swatches: RGB[];
}

export type Source = 'app' | 'schedule' | 'agent';

export interface ActivityEntry {
  id: string;
  at: number;
  source: Source;
  text: string;
  ok: boolean;
  detail?: string;
}

export interface Status {
  mode: 'cloud' | 'demo';
  connected: boolean;
  error: string | null;
  requestsToday: number;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  sun: { sunrise: number; sunset: number } | null;
  timezone: string;
  authRequired: boolean;
  /** Whether look suggestions from a description are available. */
  ai: boolean;
  /** Local network control: off, or on with any problem that stops it working. */
  lan: { enabled: boolean; error: string | null };
  /** Where the app can be opened from: this computer, the home network, and Tailscale when present. */
  addresses: { kind: 'computer' | 'network' | 'tailscale'; label: string; url: string }[];
  version: string;
}

export interface Snapshot {
  devices: Device[];
  groups: Group[];
  looks: Look[];
  schedules: ScheduleView[];
  settings: Settings;
  status: Status;
  activity: ActivityEntry[];
}

/** A saved copy of the setup: looks, zones, schedules, settings, and how lights are named and arranged. */
export interface BackupInfo {
  name: string;
  /** `daily` is made automatically; `before-restore` is taken just before a restore so it can be undone. */
  kind: 'daily' | 'manual' | 'before-restore';
  at: number;
  looks: number;
  zones: number;
  schedules: number;
}

export interface ApplySummary {
  applied: string[];
  skipped: { deviceId: string; name: string; reason: string }[];
}
