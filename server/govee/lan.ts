import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { parts, rgbOf } from '../../shared/color';
import type { CloudState, Command } from './cloud';

/**
 * Govee's local network API: UDP messages straight to the lights, with no cloud, no
 * request quota and no noticeable delay. It only covers power, brightness, a single
 * colour and white temperature; segments and scenes still need the cloud API.
 *
 * Each light must have "LAN Control" switched on in the Govee Home app.
 */

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
  /** A light not heard from for this long is treated as unreachable until it answers a scan again. */
  staleAfterMs?: number;
  statusTimeoutMs?: number;
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
  staleAfterMs: 150_000,
  statusTimeoutMs: 1_200,
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
    await this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
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
    await this.send(data, light.port, light.ip);
  }

  /** Reads power, brightness and colour from the light. Null when it does not answer in time. */
  async status(id: string): Promise<CloudState | null> {
    const light = this.lights.get(id);
    if (!light || !this.socket) return null;
    const answer = new Promise<CloudState | null>((resolve) => {
      const waiters = this.waiting.get(id) ?? [];
      const timer = setTimeout(() => {
        const list = this.waiting.get(id);
        if (list) this.waiting.set(id, list.filter((w) => w !== done));
        resolve(null);
      }, this.opts.statusTimeoutMs);
      const done = (state: CloudState) => {
        clearTimeout(timer);
        resolve(state);
      };
      waiters.push(done);
      this.waiting.set(id, waiters);
    });
    try {
      await this.send(message('devStatus', {}), light.port, light.ip);
    } catch {
      return null;
    }
    return answer;
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
