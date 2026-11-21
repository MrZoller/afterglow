import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { parts, rgbOf } from '../../shared/color';
import type { RGB } from '../../shared/types';
import type { CloudState, Command } from './cloud';

/**
 * Govee's local network API: UDP messages straight to the lights, with no cloud, no
 * request quota and no noticeable delay. As documented it only covers power, brightness,
 * a single colour and white temperature; scenes still need the cloud API.
 *
 * Segment colours can also be sent this way with `ptReal`, a message Govee does not
 * document: it carries frames of the protocol the Govee app speaks over Bluetooth. The
 * layout used here is the one two community projects send (govee-local-api, used by
 * Home Assistant, and govee-lan-bridge). Whether a given model acts on it has to be
 * found out on the light, which is why the app only uses it where the owner has tried it.
 *
 * Each light must have "LAN Control" switched on in the Govee Home app.
 */

/** Frames a light takes in one message. Lights have been seen to accept 18 and to drop a message of 24 whole. */
export const MAX_FRAMES = 12;
/** The most segments a design is painted on locally: the longest light the message has been reported to address. */
export const MAX_PAINT_SEGMENTS = 24;

/** One 20-byte frame: the data, zero padding, then a checksum that is the XOR of the 19 bytes before it. */
export function frame(data: number[]): Buffer {
  const bytes = Buffer.alloc(20);
  data.slice(0, 19).forEach((b, i) => (bytes[i] = b & 0xff));
  bytes[19] = bytes.subarray(0, 19).reduce((x, b) => x ^ b, 0);
  return bytes;
}

/**
 * The frame that gives some of a light's segments one colour. Which segments is a
 * little-endian bit mask starting at byte 12: segment i, counting from 0, is bit i.
 */
export function segmentFrame(rgb: RGB, segments: number[], count: number): Buffer {
  const mask = Array<number>(Math.ceil(count / 8)).fill(0);
  for (const i of segments) if (Number.isInteger(i) && i >= 0 && i < count) mask[i >> 3] |= 1 << (i & 7);
  const [r, g, b] = parts(rgb);
  return frame([0x33, 0x05, 0x15, 0x01, r, g, b, 0, 0, 0, 0, 0, ...mask]);
}

export type LanCommand = Extract<Command, { cap: 'power' | 'brightness' | 'color' | 'colorTemp' }>;

export const isLanCommand = (cmd: Command): cmd is LanCommand => cmd.cap === 'power' || cmd.cap === 'brightness' || cmd.cap === 'color' || cmd.cap === 'colorTemp';

export interface LanOptions {
  /** Where discovery requests go. Lights with LAN control on listen on this multicast group. */
  scanAddress?: string;
  scanPort?: number;
  /** Lights send their replies to this port on whoever asked. */
  listenPort?: number;
  /** Lights take commands on this port. */
  controlPort?: number;
  scanEveryMs?: number;
  /**
   * Extra looks for lights shortly after starting, as delays from the start. The answers to
   * the very first one are easily missed (on the owner's network it found nothing after a
   * restart), and waiting for the regular scan leaves the lights to the cloud for a minute.
   */
  earlyScansMs?: number[];
  /** A light not heard from for this long is treated as unreachable until it answers a scan again. */
  staleAfterMs?: number;
  statusTimeoutMs?: number;
  /**
   * Shortest time between two messages to the same light. A light is busy for a moment
   * after each one, and a message arriving meanwhile has been seen to be dropped silently.
   */
  minGapMs?: number;
}

interface LanLight {
  id: string;
  sku: string;
  ip: string;
  port: number;
  seenAt: number;
}

const DEFAULTS = {
  scanAddress: '239.255.255.250',
  scanPort: 4001,
  listenPort: 4002,
  controlPort: 4003,
  scanEveryMs: 60_000,
  earlyScansMs: [2_000, 5_000, 10_000, 20_000],
  staleAfterMs: 150_000,
  statusTimeoutMs: 1_200,
  minGapMs: 150,
};

const message = (cmd: string, data: object) => Buffer.from(JSON.stringify({ msg: { cmd, data } }));

export class GoveeLan extends EventEmitter {
  /** Why local control is unavailable, e.g. another app already holds the port. */
  error: string | null = null;

  private opts: typeof DEFAULTS;
  private socket: dgram.Socket | null = null;
  private lights = new Map<string, LanLight>();
  private waiting = new Map<string, ((state: CloudState) => void)[]>();
  private timer: NodeJS.Timeout | null = null;
  private early: NodeJS.Timeout[] = [];
  /** Per light: the message in front of the next one, and when the last one went out. */
  private queue = new Map<string, Promise<void>>();
  private sentAt = new Map<string, number>();

  constructor(options: LanOptions = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Opens the socket and starts looking for lights. Never throws: on failure the app stays cloud-only. */
  async start(): Promise<void> {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(this.opts.listenPort, () => {
          socket.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.error = code === 'EADDRINUSE' ? `Port ${this.opts.listenPort} is in use by another app on this computer` : (err as Error).message;
      socket.close();
      return;
    }
    try {
      // Some lights answer on the group rather than directly; joining it catches both.
      socket.addMembership(this.opts.scanAddress);
    } catch {
      // Not a multicast address (tests), or no multicast route: direct replies still arrive.
    }
    socket.on('message', (data, from) => this.receive(data, from));
    socket.on('error', (err) => (this.error = err.message));
    this.socket = socket;
    this.timer = setInterval(() => void this.scan(), this.opts.scanEveryMs);
    this.timer.unref();
    this.early = this.opts.earlyScansMs.map((delay) => setTimeout(() => void this.scan(), delay).unref());
    await this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.early.forEach((t) => clearTimeout(t));
    this.socket?.close();
    this.socket = null;
  }

  /** True when the light answered recently and can be driven locally. */
  has(id: string): boolean {
    const light = this.lights.get(id);
    return !!this.socket && !!light && Date.now() - light.seenAt < this.opts.staleAfterMs;
  }

  /** Ids of lights reachable locally right now. */
  reachable(): string[] {
    return [...this.lights.keys()].filter((id) => this.has(id));
  }

  private send(data: Buffer, port: number, address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Local control is not running'));
      this.socket.send(data, port, address, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Sends to one light, in turn and no sooner after the last message to it than it can take. */
  private sendTo(light: LanLight, data: Buffer): Promise<void> {
    const turn = (this.queue.get(light.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const wait = (this.sentAt.get(light.id) ?? 0) + this.opts.minGapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        try {
          await this.send(data, light.port, light.ip);
        } finally {
          this.sentAt.set(light.id, Date.now());
        }
      });
    this.queue.set(light.id, turn);
    return turn;
  }

  /** Asks every light on the network to announce itself. */
  async scan(): Promise<void> {
    if (!this.socket) return;
    const request = message('scan', { account_topic: 'reserve' });
    const multicast = /^(22[4-9]|23\d)\./.test(this.opts.scanAddress);
    // A computer on both Wi-Fi and Ethernet must ask on each network, or lights on the other one never hear it.
    const addresses = multicast
      ? Object.values(os.networkInterfaces())
          .flat()
          .filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === 'IPv4' && !n.internal)
          .map((n) => n.address)
      : [];
    for (const address of addresses.length ? addresses : [null]) {
      try {
        if (address) this.socket.setMulticastInterface(address);
        await this.send(request, this.opts.scanPort, this.opts.scanAddress);
      } catch {
        // An interface without a multicast route; the others may still work.
      }
    }
  }

  private receive(data: Buffer, from: dgram.RemoteInfo): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString()).msg;
    } catch {
      return;
    }
    if (msg?.cmd === 'scan' && typeof msg.data?.device === 'string') {
      const id: string = msg.data.device;
      const before = this.lights.get(id);
      const wasReachable = this.has(id);
      const ip = typeof msg.data.ip === 'string' && msg.data.ip ? msg.data.ip : from.address;
      // Real lights always use the standard port; the simulator runs several lights on one address.
      const port = Number.isInteger(msg.data.port) ? msg.data.port : this.opts.controlPort;
      this.lights.set(id, { id, sku: String(msg.data.sku ?? ''), ip, port, seenAt: Date.now() });
      if (!wasReachable || before?.ip !== ip) this.emit('change');
      return;
    }
    if (msg?.cmd === 'devStatus' && msg.data) {
      const candidates = [...this.lights.values()].filter((l) => l.ip === from.address);
      const light = candidates.find((l) => l.port === from.port) ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!light) return;
      light.seenAt = Date.now();
      const d = msg.data;
      const kelvin = Number(d.colorTemInKelvin);
      const state: CloudState = {
        online: true,
        power: d.onOff === undefined ? null : Number(d.onOff) === 1,
        brightness: Number.isFinite(Number(d.brightness)) ? Number(d.brightness) : null,
        rgb: d.color ? rgbOf(Number(d.color.r) || 0, Number(d.color.g) || 0, Number(d.color.b) || 0) : null,
        kelvin: kelvin > 0 ? kelvin : null,
      };
      const waiters = this.waiting.get(light.id) ?? [];
      this.waiting.delete(light.id);
      waiters.forEach((resolve) => resolve(state));
    }
  }

  /** Sends a command. UDP gives no receipt; follow with status() to confirm the light is answering. */
  async command(id: string, cmd: LanCommand): Promise<void> {
    const light = this.lights.get(id);
    if (!light) throw new Error('Light is not reachable locally');
    let data: Buffer;
    switch (cmd.cap) {
      case 'power':
        data = message('turn', { value: cmd.on ? 1 : 0 });
        break;
      case 'brightness':
        data = message('brightness', { value: cmd.value });
        break;
      case 'color': {
        const [r, g, b] = parts(cmd.rgb);
        data = message('colorwc', { color: { r, g, b }, colorTemInKelvin: 0 });
        break;
      }
      case 'colorTemp':
        data = message('colorwc', { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: cmd.kelvin });
        break;
    }
    await this.sendTo(light, data);
  }

  /**
   * Paints a design on a light: each group of segments gets its colour. Sent with the
   * undocumented `ptReal` message, a few frames at a time. Like every local command it
   * comes with no receipt, and the light cannot report its segments back.
   */
  async paint(id: string, groups: { rgb: RGB; segments: number[] }[], count: number): Promise<void> {
    const light = this.lights.get(id);
    if (!light) throw new Error('Light is not reachable locally');
    if (count < 1 || count > MAX_PAINT_SEGMENTS) throw new Error('Light has more segments than a local design can address');
    const frames = groups.map((g) => segmentFrame(g.rgb, g.segments, count).toString('base64'));
    for (let i = 0; i < frames.length; i += MAX_FRAMES) {
      await this.sendTo(light, message('ptReal', { command: frames.slice(i, i + MAX_FRAMES) }));
    }
  }

  /** Reads power, brightness and colour from the light. Null when it does not answer in time. */
  async status(id: string): Promise<CloudState | null> {
    const light = this.lights.get(id);
    if (!light || !this.socket) return null;
    let settle!: (state: CloudState | null) => void;
    const answer = new Promise<CloudState | null>((resolve) => (settle = resolve));
    const waiter = (state: CloudState) => settle(state);
    this.waiting.set(id, [...(this.waiting.get(id) ?? []), waiter]);
    const forget = () => {
      const list = this.waiting.get(id);
      if (list) this.waiting.set(id, list.filter((w) => w !== waiter));
    };
    try {
      await this.sendTo(light, message('devStatus', {}));
    } catch {
      forget();
      return null;
    }
    // The clock starts once the question has actually gone out, which may be a moment after it was asked.
    const timer = setTimeout(() => {
      forget();
      settle(null);
    }, this.opts.statusTimeoutMs);
    return answer.finally(() => clearTimeout(timer));
  }

  /** Stops using a light locally until it answers a scan again. */
  forget(id: string): void {
    const light = this.lights.get(id);
    if (light && light.seenAt !== 0) {
      light.seenAt = 0;
      this.emit('change');
    }
  }
}
