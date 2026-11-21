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
}

export interface FakeLan {
  /** Port to send discovery requests to. */
  scanPort: number;
  /** Every command received, oldest first. */
  received: { device: string; cmd: string; data: any }[];
  /** Makes a light stop answering, as if it dropped off the network. */
  mute(device: string): void;
  unmute(device: string): void;
  close(): Promise<void>;
}

const bind = (socket: dgram.Socket) => new Promise<number>((resolve) => socket.bind(0, '127.0.0.1', () => resolve((socket.address() as AddressInfo).port)));

export async function startFakeLan(lights: SharedLight[]): Promise<FakeLan> {
  const received: FakeLan['received'] = [];
  const muted = new Set<string>();
  const sockets: dgram.Socket[] = [];

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
        if (msg.cmd !== 'devStatus') received.push({ device: light.device, cmd: msg.cmd, data: msg.data });
        if (msg.cmd === 'turn') light.power = msg.data.value ? 1 : 0;
        else if (msg.cmd === 'brightness') light.brightness = msg.data.value;
        else if (msg.cmd === 'colorwc') {
          if (msg.data.colorTemInKelvin) light.colorTemperatureK = msg.data.colorTemInKelvin;
          else {
            light.colorRgb = (msg.data.color.r << 16) | (msg.data.color.g << 8) | msg.data.color.b;
            light.colorTemperatureK = 0;
          }
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
  scanner.on('message', (data, from) => {
    if (!data.toString().includes('"scan"')) return;
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
    close: () => Promise.all(sockets.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))).then(() => undefined),
  };
}
