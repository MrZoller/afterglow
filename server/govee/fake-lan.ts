import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';

/**
 * Simulated lights speaking Govee's local network protocol on this computer, for demo
 * mode and the tests. They share state with the simulated cloud service, so a change
 * made one way shows up the other.
 */

interface SharedLight {
  sku: string;
  device: string;
  power: number;
  brightness: number;
  colorRgb: number;
  colorTemperatureK: number;
  segments?: number;
  segmentColors?: number[];
}

export interface FakeLan {
  /** Port to send discovery requests to. */
  scanPort: number;
  /** Every command received, oldest first. */
  received: { device: string; cmd: string; data: any }[];
  /** Makes a light stop answering, as if it dropped off the network. */
  mute(device: string): void;
  unmute(device: string): void;
  /** Makes a light ignore designs sent with `ptReal`, like a model that does not take that message. */
  plain(device: string, on?: boolean): void;
  /** Messages dropped because they arrived while a light was still busy with the one before. */
  dropped: number;
  close(): Promise<void>;
}

const bind = (socket: dgram.Socket) => new Promise<number>((resolve) => socket.bind(0, '127.0.0.1', () => resolve((socket.address() as AddressInfo).port)));

/** Frames in one `ptReal` message beyond which the simulated lights drop it whole, as real ones have been seen to. */
const TOO_MANY_FRAMES = 18;

export async function startFakeLan(
  lights: SharedLight[],
  opts: {
    /** How long a light is busy after a message; one arriving sooner is dropped, as real lights have been seen to do. */
    busyMs?: number;
    /** How many scans go unanswered at first, as when the first answers after a restart are lost. */
    missedScans?: number;
  } = {},
): Promise<FakeLan> {
  const received: FakeLan['received'] = [];
  const muted = new Set<string>();
  const plain = new Set<string>();
  const sockets: dgram.Socket[] = [];
  const busyUntil = new Map<string, number>();
  let dropped = 0;

  /** Acts on the frames of a `ptReal` message that set segment colours; anything malformed is ignored, as a light would. */
  const paint = (light: SharedLight, frames: unknown) => {
    if (!Array.isArray(frames) || frames.length > TOO_MANY_FRAMES || !light.segmentColors) return;
    for (const encoded of frames) {
      const bytes = Buffer.from(String(encoded), 'base64');
      if (bytes.length !== 20 || bytes.subarray(0, 19).reduce((x, b) => x ^ b, 0) !== bytes[19]) continue;
      if (bytes[0] !== 0x33 || bytes[1] !== 0x05 || bytes[2] !== 0x15 || bytes[3] !== 0x01) continue;
      const rgb = (bytes[4] << 16) | (bytes[5] << 8) | bytes[6];
      for (let i = 0; i < light.segmentColors.length; i++) if (bytes[12 + (i >> 3)] & (1 << (i & 7))) light.segmentColors[i] = rgb;
    }
  };

  const units = await Promise.all(
    lights.map(async (light) => {
      const socket = dgram.createSocket('udp4');
      sockets.push(socket);
      const port = await bind(socket);
      socket.on('message', (data, from) => {
        if (muted.has(light.device)) return;
        let msg: any;
        try {
          msg = JSON.parse(data.toString()).msg;
        } catch {
          return;
        }
        if (opts.busyMs) {
          const now = Date.now();
          if (now < (busyUntil.get(light.device) ?? 0)) {
            dropped += 1;
            return;
          }
          busyUntil.set(light.device, now + opts.busyMs);
        }
        if (msg.cmd !== 'devStatus') received.push({ device: light.device, cmd: msg.cmd, data: msg.data });
        if (msg.cmd === 'turn') light.power = msg.data.value ? 1 : 0;
        else if (msg.cmd === 'brightness') light.brightness = msg.data.value;
        else if (msg.cmd === 'colorwc') {
          if (msg.data.colorTemInKelvin) light.colorTemperatureK = msg.data.colorTemInKelvin;
          else {
            light.colorRgb = (msg.data.color.r << 16) | (msg.data.color.g << 8) | msg.data.color.b;
            light.colorTemperatureK = 0;
            light.segmentColors?.fill(light.colorRgb);
          }
        } else if (msg.cmd === 'ptReal') {
          if (!plain.has(light.device)) paint(light, msg.data?.command);
        } else if (msg.cmd === 'devStatus') {
          const color = { r: (light.colorRgb >> 16) & 255, g: (light.colorRgb >> 8) & 255, b: light.colorRgb & 255 };
          const reply = { msg: { cmd: 'devStatus', data: { onOff: light.power, brightness: light.brightness, color, colorTemInKelvin: light.colorTemperatureK } } };
          socket.send(JSON.stringify(reply), from.port, from.address);
        }
      });
      return { light, socket, port };
    }),
  );

  // Stands in for the multicast group: every light that hears a scan announces itself.
  const scanner = dgram.createSocket('udp4');
  sockets.push(scanner);
  const scanPort = await bind(scanner);
  let unanswered = opts.missedScans ?? 0;
  scanner.on('message', (data, from) => {
    if (!data.toString().includes('"scan"')) return;
    if (unanswered-- > 0) return;
    for (const unit of units) {
      if (muted.has(unit.light.device)) continue;
      const reply = { msg: { cmd: 'scan', data: { ip: '127.0.0.1', port: unit.port, device: unit.light.device, sku: unit.light.sku, bleVersionHard: '3.01.01', bleVersionSoft: '1.03.01', wifiVersionHard: '1.00.10', wifiVersionSoft: '1.02.03' } } };
      unit.socket.send(JSON.stringify(reply), from.port, from.address);
    }
  });

  return {
    scanPort,
    received,
    mute: (device) => void muted.add(device),
    unmute: (device) => void muted.delete(device),
    plain: (device, on = true) => void (on ? plain.add(device) : plain.delete(device)),
    get dropped() {
      return dropped;
    },
    close: () => Promise.all(sockets.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))).then(() => undefined),
  };
}
