import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { accessAddresses, isTailscaleIp, parseTailscaleName, tailscaleName } from '../server/network';

const iface = (address: string, internal = false): os.NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null }) as os.NetworkInterfaceInfo;

const none = async () => null;

describe('addresses the app can be opened at', () => {
  it('recognises Tailscale addresses', () => {
    assert.equal(isTailscaleIp('100.101.102.103'), true);
    assert.equal(isTailscaleIp('100.64.0.1'), true);
    assert.equal(isTailscaleIp('100.127.255.254'), true);
    assert.equal(isTailscaleIp('100.63.0.1'), false);
    assert.equal(isTailscaleIp('100.128.0.1'), false);
    assert.equal(isTailscaleIp('192.168.1.20'), false);
  });

  it('reads the tailnet name from the Tailscale status output', () => {
    assert.equal(parseTailscaleName(JSON.stringify({ Self: { DNSName: 'mac-mini.tail1a2b3.ts.net.' } })), 'mac-mini.tail1a2b3.ts.net');
    assert.equal(parseTailscaleName(JSON.stringify({ Self: {} })), null);
    assert.equal(parseTailscaleName('not json'), null);
  });

  it('asks the Tailscale command-line tool for the name, and copes without it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-ts-'));
    const original = process.env.PATH;
    try {
      // A stand-in for the real tool that prints the same shape of output.
      fs.writeFileSync(path.join(dir, 'tailscale'), `#!/bin/sh\necho '{"Self":{"DNSName":"mac-mini.tail1a2b3.ts.net."}}'\n`, { mode: 0o755 });
      process.env.PATH = `${dir}${path.delimiter}${original}`;
      assert.equal(await tailscaleName(), 'mac-mini.tail1a2b3.ts.net');
      fs.writeFileSync(path.join(dir, 'tailscale'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const fallback = await tailscaleName();
      assert.ok(fallback === null || typeof fallback === 'string'); // null unless a real install answers
    } finally {
      process.env.PATH = original;
    }
  });

  it('lists home-network and Tailscale addresses, preferring the tailnet name', async () => {
    const interfaces = { lo0: [iface('127.0.0.1', true)], en0: [iface('192.168.1.20')], utun4: [iface('100.101.102.103')] };
    const named = await accessAddresses(4680, '0.0.0.0', interfaces, 'Mac-mini.local', async () => 'mac-mini.tail1a2b3.ts.net');
    assert.deepEqual(named, [
      { kind: 'computer', label: 'On this computer', url: 'http://localhost:4680' },
      { kind: 'network', label: 'On your home network', url: 'http://mac-mini.local:4680' },
      { kind: 'network', label: 'On your home network', url: 'http://192.168.1.20:4680' },
      { kind: 'tailscale', label: 'Anywhere, over Tailscale', url: 'http://mac-mini.tail1a2b3.ts.net:4680' },
    ]);

    // Without the Tailscale command-line tool the address still works.
    const byIp = await accessAddresses(4680, '0.0.0.0', interfaces, 'Mac-mini', none);
    assert.deepEqual(byIp.map((a) => a.url), ['http://localhost:4680', 'http://192.168.1.20:4680', 'http://100.101.102.103:4680']);
  });

  it('does not look for Tailscale when the computer is not on a tailnet', async () => {
    let asked = false;
    const out = await accessAddresses(4680, '0.0.0.0', { en0: [iface('192.168.1.20')] }, 'box', async () => {
      asked = true;
      return 'x.ts.net';
    });
    assert.equal(asked, false);
    assert.equal(out.some((a) => a.kind === 'tailscale'), false);
  });

  it('shows only the chosen address when bound to one', async () => {
    assert.deepEqual(await accessAddresses(4680, '100.101.102.103', { en0: [iface('192.168.1.20')] }, 'box', none), [{ kind: 'network', label: 'Address', url: 'http://100.101.102.103:4680' }]);
  });
});
