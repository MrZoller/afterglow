import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { fromHex, toHex } from '../shared/color';
import type { Action, Device, RGB, TimeSpec } from '../shared/types';
import { config } from './config';
import type { ApplyResult } from './hub';
import type { Services } from './http';

/** MCP endpoint: lets an AI agent see and control the lights with the same rules as the app. */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const targetsArg = z
  .array(z.string())
  .min(1)
  .describe('Which lights: light names, zone names, light ids, or "all". Names are matched case-insensitively.');

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

function hex(text: string): RGB {
  const value = fromHex(text);
  if (value === null) throw new Error(`"${text}" is not a hex colour like #ff8800`);
  return value;
}

/** "22:30", "sunset", "sunrise-15", "sunset+30" */
function parseTime(text: string): TimeSpec {
  const t = text.trim().toLowerCase();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) return { type: 'clock', time: `${clock[1].padStart(2, '0')}:${clock[2]}` };
  const sun = /^(sunrise|sunset)\s*(?:([+-])\s*(\d+))?$/.exec(t);
  if (sun) return { type: 'sun', event: sun[1] as 'sunrise' | 'sunset', offsetMin: sun[3] ? Number(sun[3]) * (sun[2] === '-' ? -1 : 1) : 0 };
  throw new Error(`"${text}" is not a time. Use 24-hour "HH:MM", "sunset", "sunrise", or an offset in minutes like "sunset+30".`);
}

const formatTime = (spec: TimeSpec) =>
  spec.type === 'clock' ? spec.time : `${spec.event}${spec.offsetMin ? (spec.offsetMin > 0 ? '+' : '') + spec.offsetMin : ''}`;

function build(services: Services): McpServer {
  const { hub, ops, scheduler } = services;
  const server = new McpServer({ name: 'afterglow', version: config.version });
  const snap = () => services.snapshot();

  /** Turns names into target strings the hub understands. */
  const resolve = (names: string[]): string[] => {
    const { devices, groups } = snap();
    return names.map((raw) => {
      const q = raw.trim().toLowerCase();
      if (['all', 'everything', 'all lights'].includes(q)) return 'all';
      const group = groups.find((g) => g.name.toLowerCase() === q || `group:${g.id}` === raw);
      if (group) return `group:${group.id}`;
      const exact = devices.find((d) => d.id === raw || d.name.toLowerCase() === q);
      if (exact) return exact.id;
      const partial = devices.filter((d) => d.name.toLowerCase().includes(q));
      if (partial.length === 1) return partial[0].id;
      throw new Error(`No light or zone called "${raw}". Zones: ${groups.map((g) => g.name).join(', ') || 'none'}. Lights: ${devices.map((d) => d.name).join(', ')}.`);
    });
  };

  const findLook = (ref: string) => {
    const look = snap().looks.find((l) => l.id === ref || l.name.toLowerCase() === ref.trim().toLowerCase());
    if (!look) throw new Error(`No look called "${ref}". Looks: ${snap().looks.map((l) => l.name).join(', ')}.`);
    return look;
  };

  const findSchedule = (ref: string) => {
    const schedule = snap().schedules.find((s) => s.id === ref || s.name.toLowerCase() === ref.trim().toLowerCase());
    if (!schedule) throw new Error(`No schedule called "${ref}". Schedules: ${snap().schedules.map((s) => s.name).join(', ') || 'none'}.`);
    return schedule;
  };

  const showing = (d: Device) => {
    const a = d.state.appearance;
    if (a.mode === 'color') return toHex(a.rgb);
    if (a.mode === 'temp') return `white ${a.kelvin}K`;
    if (a.mode === 'segments') return `segments ${a.colors.map(toHex).join(' ')}`;
    if (a.mode === 'scene') return `scene "${a.scene.name}"`;
    return 'unknown';
  };

  /** Waits briefly for delivery so the agent hears about failures. */
  const report = async (results: ApplyResult[]) => {
    const settled = await Promise.race([
      Promise.all(results.map((r) => r.done)),
      new Promise<null>((r) => setTimeout(() => r(null), 12_000)),
    ]);
    const applied = new Set(results.flatMap((r) => r.summary.applied));
    const skipped = results.flatMap((r) => r.summary.skipped).map((s) => `${s.name} (${s.reason})`);
    const failed = settled?.flatMap((r) => r.failed).map((f) => `${f.name}: ${f.error}`) ?? [];
    const lines = [`Applied to ${applied.size} light${applied.size === 1 ? '' : 's'}.`];
    if (skipped.length) lines.push(`Skipped: ${skipped.join('; ')}.`);
    if (failed.length) lines.push(`Failed: ${failed.join('; ')}.`);
    if (!settled) lines.push('Some commands are still being sent; Govee limits how fast each light accepts them.');
    return failed.length && failed.length >= applied.size ? fail(lines.join(' ')) : ok(lines.join(' '));
  };

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ReturnType<typeof ok>> | ReturnType<typeof ok>,
    readOnly = false,
  ) =>
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly } }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return await handler(args);
      } catch (err) {
        return fail(err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message);
      }
    }) as never);

  tool(
    'list_lights',
    'Lists every light with its current state, plus zones (named groups of lights), today\'s sunrise and sunset, and connection status. Call this first to learn the names to use as targets.',
    {},
    () => {
      const { devices, groups, status } = snap();
      return ok({
        lights: devices.map((d) => ({
          id: d.id,
          name: d.name,
          model: d.sku,
          type: d.kind,
          zones: groups.filter((g) => g.deviceIds.includes(d.id)).map((g) => g.name),
          on: d.state.power,
          brightness: d.state.brightness,
          showing: showing(d),
          moving: d.moving || undefined,
          reached: d.local ? 'local network' : 'cloud',
          segments: d.caps.segments,
          online: d.state.online,
          // How often it could not be reached lately; several a week usually means weak Wi-Fi at the light.
          dropouts_last_7_days: d.dropouts.week || undefined,
          problem: d.error ?? undefined,
        })),
        zones: groups.map((g) => ({
          name: g.name,
          lights: g.deviceIds.map((id) => devices.find((d) => d.id === id)?.name).filter(Boolean),
          // Joined lights are mounted end to end: designs applied to the whole zone run across them as one.
          joined_end_to_end: g.joined || undefined,
        })),
        sun: status.sun ? { sunrise: new Date(status.sun.sunrise).toLocaleTimeString(), sunset: new Date(status.sun.sunset).toLocaleTimeString() } : 'location not set',
        connection: status.connected ? status.mode : `problem: ${status.error}`,
      });
    },
    true,
  );

  tool(
    'control_lights',
    'Turns lights on or off and sets brightness, a single colour, or a white temperature. Give at least one setting. Setting a colour or white also turns the lights on.',
    {
      targets: targetsArg,
      power: z.enum(['on', 'off']).optional(),
      brightness: z.number().int().min(1).max(100).optional().describe('Percent'),
      color: z.string().optional().describe('Hex colour such as #ff8800'),
      color_temperature_k: z.number().int().min(2000).max(9000).optional().describe('White temperature in kelvin: 2700 is warm, 6500 is daylight'),
    },
    async (a) => {
      const targets = resolve(a.targets);
      const actions: Action[] = [];
      if (a.power === 'off') actions.push({ type: 'power', on: false });
      else {
        if (a.color !== undefined) actions.push({ type: 'color', rgb: hex(a.color) });
        else if (a.color_temperature_k !== undefined) actions.push({ type: 'colorTemp', kelvin: a.color_temperature_k });
        if (a.brightness !== undefined) actions.push({ type: 'brightness', value: a.brightness });
        if (a.power === 'on' && a.color === undefined && a.color_temperature_k === undefined) actions.push({ type: 'power', on: true });
      }
      if (actions.length === 0) throw new Error('Give at least one of power, brightness, color or color_temperature_k.');
      const results: ApplyResult[] = [];
      for (const action of actions) results.push(await hub.apply(targets, action, 'agent'));
      return report(results);
    },
  );

  tool(
    'paint_segments',
    'Paints a list of colours along the length of each light. The list is stretched to fit each light\'s segment count, so 3 colours on a 15-segment rope gives 3 bands. Each distinct colour costs one request per light; keep to 8 or fewer distinct colours.',
    { targets: targetsArg, colors: z.array(z.string()).min(1).max(60).describe('Hex colours in order from one end to the other') },
    async (a) => report([await hub.apply(resolve(a.targets), { type: 'segments', colors: a.colors.map(hex) }, 'agent')]),
  );

  tool(
    'list_scenes',
    'Lists the animated scenes built into the lights, plus DIY scenes and snapshots saved in the Govee app. Scene lists differ between models.',
    { targets: targetsArg },
    async (a) => {
      const { scenes, lights } = await hub.scenes(resolve(a.targets));
      const names = (kind: string) => scenes.filter((s) => s.kind === kind).map((s) => (s.supported < lights ? `${s.name} (${s.supported} of ${lights} lights)` : s.name));
      return ok({ built_in: names('light'), diy: names('diy'), snapshots: names('snapshot') });
    },
    true,
  );

  tool(
    'apply_scene',
    'Applies a Govee scene by name (from list_scenes). Lights that do not have the scene are skipped.',
    { targets: targetsArg, name: z.string(), kind: z.enum(['built_in', 'diy', 'snapshot']).optional().describe('Only needed when the same name exists in more than one category') },
    async (a) => {
      const targets = resolve(a.targets);
      const { scenes } = await hub.scenes(targets);
      const wanted = a.kind === 'built_in' ? 'light' : a.kind;
      const match = scenes.find((s) => s.name.toLowerCase() === a.name.trim().toLowerCase() && (!wanted || s.kind === wanted));
      if (!match) throw new Error(`No scene called "${a.name}". Use list_scenes to see what is available.`);
      return report([await hub.apply(targets, { type: 'scene', scene: { kind: match.kind, name: match.name } }, 'agent')]);
    },
  );

  tool(
    'list_looks',
    'Lists saved looks: reusable colour designs made in this app (a palette plus a pattern).',
    {},
    () => ok(snap().looks.map((l) => ({ id: l.id, name: l.name, colors: l.colors.map(toHex), pattern: l.pattern, brightness: l.brightness, motion_minutes: l.motion?.loopMinutes }))),
    true,
  );

  tool(
    'save_look',
    'Creates a look, or updates one when id is given. Patterns: "gradient" blends the colours along each light; "blocks" splits each light into equal bands; "alternate" repeats the colours segment by segment; "perLight" gives each light the next colour in the palette; "solid" uses the first colour everywhere. Set motion_minutes to make the colours move slowly through the palette, one full loop in that many minutes: with "solid" the lights change colour together, with "perLight" colours travel from light to light, otherwise they flow along each light. Only slow movement is possible (20 to 120 minutes suits most looks); it runs until something else is applied or the lights are switched off.',
    {
      id: z.string().optional().describe('Id of an existing look to replace'),
      name: z.string(),
      colors: z.array(z.string()).min(1).max(8).describe('Hex colours'),
      pattern: z.enum(['gradient', 'blocks', 'alternate', 'perLight', 'solid']),
      brightness: z.number().int().min(1).max(100).optional().describe('Brightness to set when the look is applied; omit to leave brightness alone'),
      motion_minutes: z.number().int().min(2).max(720).optional().describe('Minutes for one slow loop through the palette; omit for a still look'),
    },
    (a) => {
      const motion = a.motion_minutes ? { loopMinutes: a.motion_minutes } : null;
      const look = ops.saveLook({ name: a.name, colors: a.colors.map(hex), pattern: a.pattern, brightness: a.brightness ?? null, motion }, a.id);
      return ok(`Saved look "${look.name}" (id ${look.id})${motion ? `, moving through its colours every ${motion.loopMinutes} minutes` : ''}.`);
    },
  );

  tool('apply_look', 'Applies a saved look by name or id.', { targets: targetsArg, look: z.string() }, async (a) =>
    report([await hub.apply(resolve(a.targets), { type: 'look', lookId: findLook(a.look).id }, 'agent')]),
  );

  tool('delete_look', 'Deletes a saved look by name or id.', { look: z.string() }, (a) => {
    const look = findLook(a.look);
    ops.deleteLook(look.id);
    return ok(`Deleted look "${look.name}".`);
  });

  tool(
    'list_schedules',
    'Lists schedules with when each next runs.',
    {},
    () =>
      ok(
        snap().schedules.map((s) => ({
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          days: s.days.map((d) => DAYS[d]),
          start: formatTime(s.start),
          end: s.end ? formatTime(s.end) : null,
          season: s.season,
          targets: hub.describeTargets(s.targets),
          does: hub.describeAction(s.action),
          next: s.next ? `${s.next.kind === 'end' ? 'turns off' : 'starts'} ${new Date(s.next.at).toLocaleString()}` : null,
          // Whether the lights were confirmed off the last time this schedule switched them off.
          last_turn_off: s.checkingOff ? 'still being checked' : s.lastOff ? `${s.lastOff.ok ? 'confirmed' : 'problem'}: ${s.lastOff.text} (${new Date(s.lastOff.at).toLocaleString()})` : undefined,
          // Lights that missed what the schedule last did and are still being tried.
          still_trying: s.catchingUp ? `to ${s.catchingUp.kind === 'end' ? 'turn off' : 'start'} ${s.catchingUp.lights.join(', ')}` : undefined,
          problem: s.problem ?? undefined,
        })),
      ),
    true,
  );

  tool(
    'save_schedule',
    'Creates a schedule, or replaces one when id is given. Times are local: 24-hour "HH:MM", or "sunset" / "sunrise" with an optional offset in minutes such as "sunset-20". If end is given the lights turn off then (the next morning if it is earlier than start).',
    {
      id: z.string().optional().describe('Id of an existing schedule to replace'),
      name: z.string(),
      targets: targetsArg,
      start: z.string().describe('e.g. "sunset", "sunset+30", "18:45"'),
      end: z.string().optional().describe('When to turn the lights off, e.g. "23:00"'),
      days: z.array(z.enum(DAYS)).optional().describe('Defaults to every day'),
      season: z.object({ from: z.string(), to: z.string() }).optional().describe('Only run between these dates each year, as MM-DD; may wrap the new year, e.g. 12-01 to 01-06'),
      do: z.enum(['turn_on', 'turn_off', 'apply_look', 'apply_scene', 'set_color', 'set_white']),
      value: z.string().optional().describe('Look name for apply_look, scene name for apply_scene, hex colour for set_color, kelvin for set_white'),
      enabled: z.boolean().optional(),
    },
    async (a) => {
      const targets = resolve(a.targets);
      const need = () => {
        if (!a.value) throw new Error(`"${a.do}" needs a value.`);
        return a.value;
      };
      let action: Action;
      if (a.do === 'turn_on') action = { type: 'power', on: true };
      else if (a.do === 'turn_off') action = { type: 'power', on: false };
      else if (a.do === 'apply_look') action = { type: 'look', lookId: findLook(need()).id };
      else if (a.do === 'set_color') action = { type: 'color', rgb: hex(need()) };
      else if (a.do === 'set_white') action = { type: 'colorTemp', kelvin: Number(need()) };
      else {
        const { scenes } = await hub.scenes(targets);
        const match = scenes.find((s) => s.name.toLowerCase() === need().trim().toLowerCase());
        if (!match) throw new Error(`No scene called "${a.value}". Use list_scenes to see what is available.`);
        action = { type: 'scene', scene: { kind: match.kind, name: match.name } };
      }
      const schedule = ops.saveSchedule(
        {
          name: a.name,
          enabled: a.enabled ?? true,
          days: a.days?.length ? [...new Set(a.days.map((d) => DAYS.indexOf(d)))] : [0, 1, 2, 3, 4, 5, 6],
          start: parseTime(a.start),
          end: a.end ? parseTime(a.end) : null,
          season: a.season ?? null,
          targets,
          action,
        },
        a.id,
      );
      const view = scheduler.view(schedule);
      return ok(`Saved schedule "${view.name}" (id ${view.id}). ${view.problem ?? (view.next ? `Next: ${new Date(view.next.at).toLocaleString()}.` : 'It is not due to run.')}`);
    },
  );

  tool('set_schedule_enabled', 'Pauses or resumes a schedule by name or id.', { schedule: z.string(), enabled: z.boolean() }, (a) => {
    const schedule = findSchedule(a.schedule);
    ops.setScheduleEnabled(schedule.id, a.enabled);
    return ok(`Schedule "${schedule.name}" is now ${a.enabled ? 'on' : 'paused'}.`);
  });

  tool('delete_schedule', 'Deletes a schedule by name or id.', { schedule: z.string() }, (a) => {
    const schedule = findSchedule(a.schedule);
    ops.deleteSchedule(schedule.id);
    return ok(`Deleted schedule "${schedule.name}".`);
  });

  return server;
}

/** Stateless handler: each request gets its own server and transport. */
export function mcpHandler(services: Services) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'POST') {
      res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
      return;
    }
    const server = build(services);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
}
