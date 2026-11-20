import fs from 'node:fs';
import path from 'node:path';
import { STARTER_LOOKS } from '../shared/looks';
import type { ActivityEntry, DeviceState, Group, Look, Schedule, Settings } from '../shared/types';
import type { DeviceInfo, SceneOption } from './govee/cloud';

export interface StoredDevice {
  info: DeviceInfo;
  alias: string | null;
  state: DeviceState;
}

interface Data {
  version: 1;
  devices: StoredDevice[];
  groups: Group[];
  looks: Look[];
  schedules: Schedule[];
  settings: Settings;
  activity: ActivityEntry[];
  /** Scene lists per model, cached because each fetch costs a request. */
  scenes: Record<string, { at: number; options: SceneOption[] }>;
  usage: { day: string; count: number };
}

const empty = (): Data => ({
  version: 1,
  devices: [],
  groups: [],
  looks: STARTER_LOOKS.map((look) => ({ ...look, createdAt: Date.now(), updatedAt: Date.now() })),
  schedules: [],
  settings: { location: null, swatches: [0xffb46b, 0xff3d2e, 0x19ffd6, 0x1a4dff, 0xb14bff, 0x39ff14] },
  activity: [],
  scenes: {},
  usage: { day: '', count: 0 },
});

const MAX_ACTIVITY = 200;

/** Everything the app remembers, kept in one human-readable JSON file. */
export class Store {
  data: Data;
  private file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(dir: string, name = 'afterglow.json') {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, name);
    this.data = this.load();
  }

  private load(): Data {
    if (!fs.existsSync(this.file)) return empty();
    try {
      return { ...empty(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch (err) {
      // Keep the unreadable file for recovery rather than overwriting it.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, backup);
      console.error(`Could not read ${this.file}; moved it to ${backup} and started fresh.`, err);
      return empty();
    }
  }

  /** Schedules a write; bursts of changes become one write. */
  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  log(entry: Omit<ActivityEntry, 'id' | 'at'>): ActivityEntry {
    const full: ActivityEntry = { id: crypto.randomUUID(), at: Date.now(), ...entry };
    this.data.activity.unshift(full);
    if (this.data.activity.length > MAX_ACTIVITY) this.data.activity.length = MAX_ACTIVITY;
    this.save();
    return full;
  }

  /** Counts a request against today's usage. */
  countRequest(): void {
    const day = new Date().toDateString();
    if (this.data.usage.day !== day) this.data.usage = { day, count: 0 };
    this.data.usage.count += 1;
    this.save();
  }

  requestsToday(): number {
    return this.data.usage.day === new Date().toDateString() ? this.data.usage.count : 0;
  }
}
