import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * A stand-in for Govee's cloud API with eight simulated lights. Demo mode and the tests
 * run the real client against it, so the same code path is exercised either way.
 */

interface FakeLight {
  sku: string;
  device: string;
  deviceName: string;
  segments: number;
  power: number;
  brightness: number;
  colorRgb: number;
  colorTemperatureK: number;
  /** What each segment is showing. Real lights do not report this; the simulators keep it so tests can look. */
  segmentColors: number[];
}

export interface FakeGovee {
  url: string;
  /** Every control request received, oldest first. */
  controls: { device: string; capability: { type: string; instance: string; value: unknown } }[];
  lights: FakeLight[];
  /** Lights that accept commands but do not act on them, like one that missed the message. */
  ignoring: Set<string>;
  /** Lights that have dropped off the network: commands fail and their state is reported as offline. */
  offline: Set<string>;
  /** Names of the groups, as made in the Govee app, that the device list includes alongside the lights. */
  groups: string[];
  close(): Promise<void>;
}

const ROPE_SCENES = ['Sunrise', 'Sunset', 'Aurora', 'Rainbow', 'Ocean', 'Forest', 'Firefly', 'Candlelight', 'Christmas', 'Halloween', 'Fireworks', 'Starry Sky', 'Lightning', 'Meteor', 'Breathe'];
const GARDEN_SCENES = ['Sunrise', 'Sunset', 'Aurora', 'Rainbow', 'Spring', 'Summer', 'Autumn', 'Winter', 'Christmas', 'Halloween', 'Party', 'Romantic', 'Moonlight'];

const mac = (n: number) => `AA:BB:C${n}:D4:AD:FC:${(16 + n).toString(16).toUpperCase()}:0${n}`;

function lights(): FakeLight[] {
  const make = (sku: string, name: string, i: number, segments: number, on: boolean, rgb: number): FakeLight => ({
    sku,
    device: mac(i),
    deviceName: name,
    segments,
    power: on ? 1 : 0,
    brightness: 80,
    colorRgb: rgb,
    colorTemperatureK: 0,
    segmentColors: Array<number>(segments).fill(rgb),
  });
  return [
    make('H61A9', 'Front fence rope', 1, 15, true, 0xff8a1f),
    make('H61A9', 'Patio rope', 2, 15, true, 0x19ffd6),
    make('H61A9', 'Deck rail rope', 3, 15, false, 0xb14bff),
    make('H61A9', 'Driveway rope', 4, 15, false, 0xffffff),
    make('H7086', 'Front path lights', 5, 12, true, 0xffb46b),
    make('H7086', 'Flower bed lights', 6, 12, true, 0x4dff5c),
    make('H7086', 'Back garden lights', 7, 12, false, 0x1a4dff),
    make('H7086', 'Side yard lights', 8, 12, false, 0xffffff),
  ];
}

/**
 * Groups made in the Govee app. Govee's device list returns them next to the real lights,
 * told apart only by a group model name. What their ids look like on a real account is
 * not known; these are made up.
 */
const GROUPS = [
  { sku: 'SameModeGroup', device: '11849032', deviceName: 'All ropes', instances: ['powerSwitch', 'brightness', 'colorRgb', 'colorTemperatureK'] },
  { sku: 'DreamViewScenic', device: '11849033', deviceName: 'Front scene', instances: ['powerSwitch', 'brightness'] },
  { sku: 'BaseGroup', device: '11849034', deviceName: 'Whole yard', instances: ['powerSwitch'] },
];

function capabilities(light: FakeLight) {
  // Real devices describe segments in two different ways; one model uses each here.
  const segmentField =
    light.sku === 'H61A9'
      ? { fieldName: 'segment', size: { min: 1, max: light.segments }, dataType: 'Array', elementRange: { min: 0, max: light.segments - 1 }, elementType: 'INTEGER', required: true }
      : { fieldName: 'segment', dataType: 'Array', options: Array.from({ length: light.segments }, (_, value) => ({ value })), required: true };
  return [
    { type: 'devices.capabilities.on_off', instance: 'powerSwitch', parameters: { dataType: 'ENUM', options: [{ name: 'on', value: 1 }, { name: 'off', value: 0 }] } },
    { type: 'devices.capabilities.toggle', instance: 'gradientToggle', parameters: { dataType: 'ENUM', options: [{ name: 'on', value: 1 }, { name: 'off', value: 0 }] } },
    { type: 'devices.capabilities.range', instance: 'brightness', parameters: { unit: 'unit.percent', dataType: 'INTEGER', range: { min: 1, max: 100, precision: 1 } } },
    {
      type: 'devices.capabilities.segment_color_setting',
      instance: 'segmentedColorRgb',
      parameters: { dataType: 'STRUCT', fields: [segmentField, { fieldName: 'rgb', dataType: 'INTEGER', range: { min: 0, max: 16777215, precision: 1 }, required: true }] },
    },
    { type: 'devices.capabilities.color_setting', instance: 'colorRgb', parameters: { dataType: 'INTEGER', range: { min: 0, max: 16777215, precision: 1 } } },
    { type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', parameters: { dataType: 'INTEGER', range: { min: 2000, max: 9000, precision: 1 } } },
    { type: 'devices.capabilities.dynamic_scene', instance: 'lightScene', parameters: { dataType: 'ENUM', options: [] } },
    { type: 'devices.capabilities.dynamic_scene', instance: 'diyScene', parameters: { dataType: 'ENUM', options: [] } },
    { type: 'devices.capabilities.dynamic_scene', instance: 'snapshot', parameters: { dataType: 'ENUM', options: [{ name: 'Movie night', value: 465503 }] } },
  ];
}

export async function startFakeGovee(
  opts: {
    latencyMs?: number;
    /** Simulates Govee's per-light rate limit: at most `max` control requests per `windowMs`. */
    limit?: { max: number; windowMs: number };
  } = {},
): Promise<FakeGovee> {
  const all = lights();
  const controls: FakeGovee['controls'] = [];
  const ignoring = new Set<string>();
  const offline = new Set<string>();
  const hits = new Map<string, number[]>();
  const app = express();
  app.use(express.json());

  const delay = () => new Promise((r) => setTimeout(r, opts.latencyMs ?? 120 + Math.random() * 200));
  const find = (body: any) => all.find((l) => l.device === body?.payload?.device && l.sku === body?.payload?.sku);

  app.use((req, res, next) => {
    if (!req.header('Govee-API-Key')) {
      res.status(401).json({ code: 401, message: 'Unauthorized' });
      return;
    }
    next();
  });

  app.get('/router/api/v1/user/devices', async (_req, res) => {
    await delay();
    res.json({
      code: 200,
      message: 'success',
      data: [
        ...all.map((l) => ({ sku: l.sku, device: l.device, deviceName: l.deviceName, type: 'devices.types.light', capabilities: capabilities(l) })),
        ...GROUPS.map((g) => ({ sku: g.sku, device: g.device, deviceName: g.deviceName, type: 'devices.types.light', capabilities: capabilities(all[0]).filter((c) => g.instances.includes(c.instance)) })),
      ],
    });
  });

  app.post('/router/api/v1/device/state', async (req, res) => {
    await delay();
    const light = find(req.body);
    if (!light) {
      res.status(404).json({ code: 404, msg: 'device not found' });
      return;
    }
    const state = (type: string, instance: string, value: unknown) => ({ type: `devices.capabilities.${type}`, instance, state: { value } });
    res.json({
      requestId: req.body.requestId,
      msg: 'success',
      code: 200,
      payload: {
        sku: light.sku,
        device: light.device,
        capabilities: [
          state('online', 'online', !offline.has(light.device)),
          state('on_off', 'powerSwitch', light.power),
          state('range', 'brightness', light.brightness),
          state('color_setting', 'colorRgb', light.colorRgb),
          state('color_setting', 'colorTemperatureK', light.colorTemperatureK),
          state('segment_color_setting', 'segmentedColorRgb', ''),
          state('dynamic_scene', 'lightScene', ''),
        ],
      },
    });
  });

  const scenes = (path: string, instance: string, type: string, options: (light: FakeLight) => unknown[]) =>
    app.post(path, async (req, res) => {
      await delay();
      const light = find(req.body);
      if (!light) {
        res.status(404).json({ code: 404, msg: 'device not found' });
        return;
      }
      res.json({
        requestId: req.body.requestId,
        msg: 'success',
        code: 200,
        payload: { sku: light.sku, device: light.device, capabilities: [{ type, instance, parameters: { dataType: 'ENUM', options: options(light) } }] },
      });
    });

  scenes('/router/api/v1/device/scenes', 'lightScene', 'devices.capabilities.dynamic_scene', (light) =>
    (light.sku === 'H61A9' ? ROPE_SCENES : GARDEN_SCENES).map((name, i) => ({ name, value: { paramId: 4000 + i, id: 3000 + i } })),
  );
  scenes('/router/api/v1/device/diy-scenes', 'diyScene', 'devices.capabilities.diy_color_setting', (light) =>
    light.sku === 'H61A9' ? [{ name: 'My chase', value: 8216567 }, { name: 'Game day', value: 8216568 }] : [{ name: 'Slow fade', value: 8216600 }],
  );

  app.post('/router/api/v1/device/control', async (req, res) => {
    const light = find(req.body);
    const capability = req.body?.payload?.capability;
    if (!light || !capability) {
      res.status(light ? 400 : 404).json({ code: light ? 400 : 404, msg: light ? 'Missing Parameter' : 'device not found' });
      return;
    }
    if (opts.limit) {
      const now = Date.now();
      const recent = (hits.get(light.device) ?? []).filter((t) => now - t < opts.limit!.windowMs);
      if (recent.length >= opts.limit.max) {
        const seconds = Math.ceil((recent[0] + opts.limit.windowMs - now) / 1000);
        res.status(429).set('Retry-After', String(seconds)).type('text/plain').send(`Rate limit exceeded, retry in ${seconds} seconds.`);
        return;
      }
      recent.push(now);
      hits.set(light.device, recent);
    }
    await delay();
    controls.push({ device: light.device, capability });
    if (offline.has(light.device)) {
      res.status(400).json({ code: 400, msg: 'device offline' });
      return;
    }
    if (ignoring.has(light.device)) {
      res.json({ requestId: req.body.requestId, msg: 'success', code: 200, capability: { ...capability, state: { status: 'success' } } });
      return;
    }
    const { instance, value } = capability;
    if (instance === 'powerSwitch') light.power = value ? 1 : 0;
    else if (instance === 'brightness') light.brightness = value;
    else if (instance === 'colorRgb') {
      light.colorRgb = value;
      light.colorTemperatureK = 0;
      light.segmentColors.fill(value);
    } else if (instance === 'colorTemperatureK') light.colorTemperatureK = value;
    else if (instance === 'segmentedColorRgb') for (const i of value?.segment ?? []) if (i >= 0 && i < light.segments) light.segmentColors[i] = value.rgb;
    res.json({ requestId: req.body.requestId, msg: 'success', code: 200, capability: { ...capability, state: { status: 'success' } } });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    controls,
    lights: all,
    ignoring,
    offline,
    groups: GROUPS.map((g) => g.deviceName),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
