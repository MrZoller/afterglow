import { z } from 'zod';
import type { Action, Group, Look, Schedule, Settings } from '../shared/types';
import { HttpError, type Hub } from './hub';
import type { Store } from './store';

/** Validation and persistence shared by the REST API and the MCP tools. */

const rgb = z.number().int().min(0).max(0xffffff);
const name = z.string().trim().min(1).max(60);
const targets = z.array(z.string().min(1)).min(1);
const motion = z.object({ loopMinutes: z.number().int().min(2).max(720) }).nullable().optional();

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('power'), on: z.boolean() }),
  z.object({ type: z.literal('brightness'), value: z.number().int().min(1).max(100) }),
  z.object({ type: z.literal('color'), rgb }),
  z.object({ type: z.literal('colorTemp'), kelvin: z.number().int().min(1000).max(10000) }),
  z.object({ type: z.literal('segments'), colors: z.array(rgb).min(1).max(200) }),
  z.object({ type: z.literal('scene'), scene: z.object({ kind: z.enum(['light', 'diy', 'snapshot']), name: z.string().min(1) }) }),
  z.object({ type: z.literal('look'), lookId: z.string().min(1) }),
  z.object({
    type: z.literal('palette'),
    colors: z.array(rgb).min(1).max(8),
    pattern: z.enum(['solid', 'perLight', 'gradient', 'blocks', 'alternate', 'custom']),
    segments: z.array(rgb).min(1).max(200).optional(),
    brightness: z.number().int().min(1).max(100).nullable().default(null),
    motion,
  }),
  z.object({ type: z.literal('still') }),
  z.object({ type: z.literal('toggle'), instance: z.string().min(1), on: z.boolean() }),
]);

export const controlSchema = z.object({ targets, action: actionSchema });

export const lookSchema = z.object({
  name,
  colors: z.array(rgb).min(1).max(8),
  pattern: z.enum(['solid', 'perLight', 'gradient', 'blocks', 'alternate', 'custom']),
  segments: z.array(rgb).min(1).max(200).optional(),
  brightness: z.number().int().min(1).max(100).nullable().default(null),
  motion,
});

const timeSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('clock'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM') }),
  z.object({ type: z.literal('sun'), event: z.enum(['sunrise', 'sunset']), offsetMin: z.number().int().min(-720).max(720) }),
]);
const monthDay = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use MM-DD');

export const scheduleSchema = z.object({
  name,
  enabled: z.boolean().default(true),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: timeSpec,
  end: timeSpec.nullable().default(null),
  season: z.object({ from: monthDay, to: monthDay }).nullable().default(null),
  targets,
  action: actionSchema,
});

export const suggestSchema = z.object({
  prompt: z.string().trim().min(1, 'Describe what you would like').max(500),
  current: z
    .object({
      name: z.string().max(60).default(''),
      colors: z.array(rgb).min(1).max(8),
      pattern: z.enum(['solid', 'perLight', 'gradient', 'blocks', 'alternate', 'custom']),
      brightness: z.number().int().min(1).max(100).nullable().default(null),
      motion,
    })
    .nullable()
    .optional(),
  targets: targets.default(['all']),
});

export const groupSchema = z.object({ name, deviceIds: z.array(z.string()).max(100) });

export const settingsSchema = z.object({
  location: z
    .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), label: z.string().trim().max(60).default('') })
    .nullable()
    .optional(),
  swatches: z.array(rgb).max(24).optional(),
});

export class Ops {
  constructor(
    private store: Store,
    private hub: Hub,
    private changed: (...kinds: ('looks' | 'schedules' | 'groups' | 'settings' | 'status' | 'devices')[]) => void,
  ) {}

  private find<T extends { id: string }>(list: T[], id: string, what: string): T {
    const item = list.find((x) => x.id === id);
    if (!item) throw new HttpError(404, `${what} not found`);
    return item;
  }

  saveLook(input: unknown, id?: string): Look {
    const data = lookSchema.parse(input);
    if (data.pattern === 'custom' && !data.segments?.length) throw new HttpError(400, 'A painted look needs its segment colours');
    const now = Date.now();
    let look: Look;
    if (id) {
      look = Object.assign(this.find(this.store.data.looks, id, 'Look'), data, { updatedAt: now });
      if (data.pattern !== 'custom') delete look.segments;
      if (!data.motion) delete look.motion;
    } else {
      look = { id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now };
      this.store.data.looks.push(look);
    }
    this.store.save();
    this.changed('looks');
    return look;
  }

  deleteLook(id: string): void {
    this.find(this.store.data.looks, id, 'Look');
    this.store.data.looks = this.store.data.looks.filter((l) => l.id !== id);
    this.store.save();
    this.changed('looks', 'schedules');
  }

  saveSchedule(input: unknown, id?: string): Schedule {
    const data = scheduleSchema.parse(input);
    if (data.action.type === 'look') this.find(this.store.data.looks, data.action.lookId, 'Look');
    if (this.hub.deviceIds(data.targets).length === 0) throw new HttpError(400, 'Choose at least one light or zone');
    // Marking both as "just ran" stops a time that already passed today from firing on save.
    const now = Date.now();
    let schedule: Schedule;
    if (id) {
      schedule = Object.assign(this.find(this.store.data.schedules, id, 'Schedule'), data, { lastStart: now, lastEnd: now });
    } else {
      schedule = { id: crypto.randomUUID(), ...data, action: data.action as Action, lastStart: now, lastEnd: now };
      this.store.data.schedules.push(schedule);
    }
    this.store.save();
    this.changed('schedules');
    return schedule;
  }

  setScheduleEnabled(id: string, enabled: boolean): Schedule {
    const schedule = this.find(this.store.data.schedules, id, 'Schedule');
    schedule.enabled = enabled;
    schedule.lastStart = schedule.lastEnd = Date.now();
    this.store.save();
    this.changed('schedules');
    return schedule;
  }

  deleteSchedule(id: string): void {
    this.find(this.store.data.schedules, id, 'Schedule');
    this.store.data.schedules = this.store.data.schedules.filter((s) => s.id !== id);
    this.store.save();
    this.changed('schedules');
  }

  saveGroup(input: unknown, id?: string): Group {
    const data = groupSchema.parse(input);
    let group: Group;
    if (id) group = Object.assign(this.find(this.store.data.groups, id, 'Zone'), data);
    else {
      group = { id: crypto.randomUUID(), ...data };
      this.store.data.groups.push(group);
    }
    this.store.save();
    this.changed('groups', 'schedules');
    return group;
  }

  deleteGroup(id: string): void {
    this.find(this.store.data.groups, id, 'Zone');
    this.store.data.groups = this.store.data.groups.filter((g) => g.id !== id);
    this.store.save();
    this.changed('groups', 'schedules');
  }

  updateSettings(input: unknown): Settings {
    const data = settingsSchema.parse(input);
    const settings = this.store.data.settings;
    if (data.location !== undefined) settings.location = data.location;
    if (data.swatches !== undefined) settings.swatches = data.swatches;
    this.store.save();
    this.changed('settings', 'schedules', 'status');
    return settings;
  }
}
