import type { DeviceCaps, RGB, SceneKind } from '../../shared/types';

/** Client for Govee's cloud "Platform API" (https://developer.govee.com). */

export interface RawCapability {
  type: string;
  instance: string;
  parameters?: any;
}

export interface SceneOption {
  kind: SceneKind;
  name: string;
  /** Opaque value Govee expects back when the scene is applied. */
  value: unknown;
}

export interface DeviceInfo {
  id: string;
  sku: string;
  goveeName: string;
  type: string;
  caps: DeviceCaps;
  /** Lowest segment index the light accepts (0 on every model seen so far). */
  segmentBase: number;
  /** Capability type per instance, as the light reports it. */
  capTypes: Record<string, string>;
  /** Scenes listed directly on the device: snapshots and any static light scenes. */
  listedScenes: SceneOption[];
}

export interface CloudState {
  online: boolean | null;
  power: boolean | null;
  brightness: number | null;
  rgb: RGB | null;
  kelvin: number | null;
}

export type Command =
  | { cap: 'power'; on: boolean }
  | { cap: 'brightness'; value: number }
  | { cap: 'color'; rgb: RGB }
  | { cap: 'colorTemp'; kelvin: number }
  | { cap: 'segmentColor'; segments: number[]; rgb: RGB }
  | { cap: 'scene'; kind: SceneKind; value: unknown }
  | { cap: 'toggle'; instance: string; on: boolean };

export class GoveeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class RateLimitError extends GoveeError {
  constructor(
    message: string,
    /** How long Govee asked us to wait, when it said. */
    readonly retryAfterMs: number | null,
  ) {
    super(message, 429);
  }
}

export interface Limits {
  dailyLimit: number | null;
  dailyRemaining: number | null;
}

const SCENE_INSTANCE: Record<SceneKind, string> = { light: 'lightScene', diy: 'diyScene', snapshot: 'snapshot' };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Govee describes the segment list either as a range or as an explicit list of indexes. */
function segmentRange(cap: RawCapability | undefined): { count: number; base: number } {
  const field = cap?.parameters?.fields?.find((f: any) => f?.fieldName === 'segment');
  if (!field) return { count: 0, base: 0 };
  if (num(field.elementRange?.max) !== null) {
    const base = num(field.elementRange.min) ?? 0;
    return { count: field.elementRange.max - base + 1, base };
  }
  const values: number[] = (field.options ?? []).map((o: any) => num(o?.value)).filter((v: number | null) => v !== null);
  if (values.length) {
    const base = Math.min(...values);
    return { count: Math.max(...values) - base + 1, base };
  }
  return { count: num(field.size?.max) ?? 0, base: 0 };
}

function sceneOptions(cap: RawCapability | undefined, kind: SceneKind): SceneOption[] {
  const options = cap?.parameters?.options;
  if (!Array.isArray(options)) return [];
  return options
    .filter((o) => typeof o?.name === 'string' && o.name.trim() && o.value !== undefined)
    .map((o) => ({ kind, name: o.name.trim(), value: o.value }));
}

export function parseDevice(raw: any): DeviceInfo | null {
  if (!raw || typeof raw.device !== 'string' || typeof raw.sku !== 'string') return null;
  const capabilities: RawCapability[] = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  const byInstance = (name: string) => capabilities.find((c) => c.instance === name);
  if (!byInstance('powerSwitch')) return null; // sensors and other things we cannot switch

  const range = (name: string) => {
    const r = byInstance(name)?.parameters?.range;
    return num(r?.min) !== null && num(r?.max) !== null ? { min: r.min as number, max: r.max as number } : null;
  };
  const segments = segmentRange(byInstance('segmentedColorRgb'));

  return {
    id: raw.device,
    sku: raw.sku,
    goveeName: typeof raw.deviceName === 'string' && raw.deviceName.trim() ? raw.deviceName.trim() : raw.sku,
    type: typeof raw.type === 'string' ? raw.type : '',
    caps: {
      power: true,
      brightness: byInstance('brightness') ? (range('brightness') ?? { min: 1, max: 100 }) : null,
      color: !!byInstance('colorRgb'),
      colorTemp: byInstance('colorTemperatureK') ? (range('colorTemperatureK') ?? { min: 2000, max: 9000 }) : null,
      segments: segments.count,
      toggles: capabilities.filter((c) => c.type?.endsWith('.toggle')).map((c) => c.instance),
    },
    segmentBase: segments.base,
    capTypes: Object.fromEntries(capabilities.map((c) => [c.instance, c.type])),
    listedScenes: [...sceneOptions(byInstance('snapshot'), 'snapshot'), ...sceneOptions(byInstance('lightScene'), 'light')],
  };
}

export class GoveeCloud {
  readonly limits: Limits = { dailyLimit: null, dailyRemaining: null };

  constructor(
    private opts: {
      apiKey: string;
      baseUrl: string;
      /** Called once per request sent, for usage tracking. */
      onRequest?: () => void;
    },
  ) {}

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    this.opts.onRequest?.();
    let res: Response;
    try {
      res = await fetch(this.opts.baseUrl + path, {
        method,
        headers: { 'Govee-API-Key': this.opts.apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GoveeError(`Could not reach Govee (${(err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message})`, 0);
    }

    const dayLimit = Number(res.headers.get('x-ratelimit-limit'));
    const dayLeft = Number(res.headers.get('x-ratelimit-remaining'));
    if (res.headers.has('x-ratelimit-limit') && Number.isFinite(dayLimit)) this.limits.dailyLimit = dayLimit;
    if (res.headers.has('x-ratelimit-remaining') && Number.isFinite(dayLeft)) this.limits.dailyRemaining = dayLeft;

    const text = await res.text();
    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      const inBody = /retry in (\d+) seconds/i.exec(text);
      const seconds = Number.isFinite(header) && header > 0 ? header : inBody ? Number(inBody[1]) : null;
      throw new RateLimitError('Govee rate limit reached', seconds === null ? null : seconds * 1000);
    }

    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Error bodies are sometimes plain text.
    }
    const code = num(json?.code) ?? res.status;
    if (!res.ok || code !== 200) {
      const detail = json?.msg ?? json?.message ?? text.slice(0, 200);
      if (res.status === 401 || code === 401) throw new GoveeError('Govee rejected the API key', 401);
      throw new GoveeError(typeof detail === 'string' && detail ? detail : `Govee returned ${res.status}`, code);
    }
    return json;
  }

  private target(info: DeviceInfo) {
    return { requestId: crypto.randomUUID(), payload: { sku: info.sku, device: info.id } };
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const json = await this.request('GET', '/router/api/v1/user/devices');
    const list: unknown[] = Array.isArray(json?.data) ? json.data : [];
    return list.map(parseDevice).filter((d): d is DeviceInfo => d !== null);
  }

  async getState(info: DeviceInfo): Promise<CloudState> {
    const json = await this.request('POST', '/router/api/v1/device/state', this.target(info));
    const caps: any[] = Array.isArray(json?.payload?.capabilities) ? json.payload.capabilities : [];
    const value = (instance: string) => caps.find((c) => c?.instance === instance)?.state?.value;
    const online = value('online');
    const power = num(value('powerSwitch'));
    const kelvin = num(value('colorTemperatureK'));
    return {
      online: typeof online === 'boolean' ? online : null,
      power: power === null ? null : power === 1,
      brightness: num(value('brightness')),
      rgb: num(value('colorRgb')),
      kelvin: kelvin && kelvin > 0 ? kelvin : null,
    };
  }

  /** Built-in and DIY scenes. Snapshots come with the device list instead. */
  async getScenes(info: DeviceInfo): Promise<SceneOption[]> {
    const fetchKind = async (path: string, kind: SceneKind) => {
      const json = await this.request('POST', path, this.target(info));
      const caps: RawCapability[] = Array.isArray(json?.payload?.capabilities) ? json.payload.capabilities : [];
      return caps.flatMap((cap) => sceneOptions(cap, kind));
    };
    const light = await fetchKind('/router/api/v1/device/scenes', 'light');
    // A light with no DIY scenes may answer with an error; that is not worth failing over.
    const diy = await fetchKind('/router/api/v1/device/diy-scenes', 'diy').catch((err) => {
      if (err instanceof RateLimitError) throw err;
      return [] as SceneOption[];
    });
    return [...light, ...diy];
  }

  async send(info: DeviceInfo, cmd: Command): Promise<void> {
    const capability = this.capability(info, cmd);
    await this.request('POST', '/router/api/v1/device/control', {
      requestId: crypto.randomUUID(),
      payload: { sku: info.sku, device: info.id, capability },
    });
  }

  private capability(info: DeviceInfo, cmd: Command): { type: string; instance: string; value: unknown } {
    const cap = (fallbackType: string, instance: string, value: unknown) => ({
      type: info.capTypes[instance] ?? `devices.capabilities.${fallbackType}`,
      instance,
      value,
    });
    switch (cmd.cap) {
      case 'power':
        return cap('on_off', 'powerSwitch', cmd.on ? 1 : 0);
      case 'brightness':
        return cap('range', 'brightness', cmd.value);
      case 'color':
        return cap('color_setting', 'colorRgb', cmd.rgb);
      case 'colorTemp':
        return cap('color_setting', 'colorTemperatureK', cmd.kelvin);
      case 'segmentColor':
        return cap('segment_color_setting', 'segmentedColorRgb', {
          segment: cmd.segments.map((i) => i + info.segmentBase),
          rgb: cmd.rgb,
        });
      case 'scene':
        return cap('dynamic_scene', SCENE_INSTANCE[cmd.kind], cmd.value);
      case 'toggle':
        return cap('toggle', cmd.instance, cmd.on ? 1 : 0);
    }
  }
}
