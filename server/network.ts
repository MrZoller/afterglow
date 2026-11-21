import { execFile } from 'node:child_process';
import os from 'node:os';

/** Works out the addresses Afterglow can be opened at, for the startup banner and Settings. */

export interface AccessAddress {
  kind: 'computer' | 'network' | 'tailscale';
  label: string;
  url: string;
}

/** Tailscale gives every device an address in 100.64.0.0/10. */
export function isTailscaleIp(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** Pulls this machine's tailnet name out of `tailscale status --json`. */
export function parseTailscaleName(json: string): string | null {
  try {
    const name = JSON.parse(json)?.Self?.DNSName;
    return typeof name === 'string' && name ? name.replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

// Under launchd the PATH is minimal, so the usual install locations are tried as well.
const TAILSCALE_CLI = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

/** This machine's tailnet name, asked of the Tailscale command-line tool. Null when that is not available. */
export async function tailscaleName(): Promise<string | null> {
  for (const bin of TAILSCALE_CLI) {
    const out = await new Promise<string | null>((resolve) => {
      execFile(bin, ['status', '--json'], { timeout: 2_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
    });
    const name = out && parseTailscaleName(out);
    if (name) return name;
  }
  return null;
}

export async function accessAddresses(
  port: number,
  host = '0.0.0.0',
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
  hostname = os.hostname(),
  lookupTailscaleName: () => Promise<string | null> = tailscaleName,
): Promise<AccessAddress[]> {
  const url = (name: string) => `http://${name}:${port}`;
  // Bound to one address on purpose: that is the only way in.
  if (host !== '0.0.0.0') return [{ kind: host === '127.0.0.1' || host === 'localhost' ? 'computer' : 'network', label: 'Address', url: url(host) }];

  const ips = Object.values(interfaces)
    .flat()
    .filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  const out: AccessAddress[] = [{ kind: 'computer', label: 'On this computer', url: url('localhost') }];

  if (/\.local$/i.test(hostname)) out.push({ kind: 'network', label: 'On your home network', url: url(hostname.toLowerCase()) });
  for (const ip of ips.filter((ip) => !isTailscaleIp(ip))) out.push({ kind: 'network', label: 'On your home network', url: url(ip) });

  const tailscaleIp = ips.find(isTailscaleIp);
  if (tailscaleIp) {
    // The name survives address changes and is easier to type; fall back to the address without it.
    const name = await lookupTailscaleName().catch(() => null);
    out.push({ kind: 'tailscale', label: 'Anywhere, over Tailscale', url: url(name ?? tailscaleIp) });
  }
  return out;
}
