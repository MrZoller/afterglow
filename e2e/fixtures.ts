import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Device, RGB, Snapshot } from '../shared/types';

/**
 * Starts the built app for one test, in demo mode with its own data folder, and hands
 * the test a small client for checking what the server ended up with.
 *
 * The app is started with AFTERGLOW_NO_ENV_FILE so it ignores any .env in the project:
 * a test run must never reach real lights, a real data folder or a real backup folder.
 */

export interface App {
  url: string;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  snapshot(): Promise<Snapshot>;
  light(name: string): Promise<Device>;
  /** The colours a light is showing, one per segment. */
  colors(name: string): Promise<RGB[]>;
  /**
   * Stops the app and starts it again on the same data, as after a power cut or a restart
   * of the computer. `edit` can change the saved data while it is stopped.
   */
  restart(edit?: (data: any) => void): Promise<void>;
  /** Makes a simulated light drop off the network, or stop obeying, and back. */
  simulate(name: string, change: { offline?: boolean; ignoring?: boolean }): Promise<void>;
}

const root = path.resolve(import.meta.dirname, '..');

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

export const test = base.extend<{ appEnv: Record<string, string>; app: App }>({
  /** Extra environment for the app under test, set per file with test.use({ appEnv }). */
  appEnv: [{}, { option: true }],

  app: async ({ appEnv }, use) => {
    const built = path.join(root, 'dist', 'server.js');
    if (!fs.existsSync(built)) throw new Error('The app has not been built. Run "npm run build" first, or use "npm run test:e2e".');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afterglow-e2e-'));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    let output = '';
    const launch = () => {
      const started = spawn(process.execPath, [built], {
        cwd: root,
        env: { ...process.env, AFTERGLOW_NO_ENV_FILE: '1', DEMO: '1', GOVEE_API_KEY: '', ACCESS_TOKEN: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', NOTIFY_URL: '', NOTIFY_TOKEN: '', AFTERGLOW_CHECK_SCALE: '', BACKUP_DIR: '', LAN: '', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ...appEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      started.stdout.on('data', (chunk) => (output += chunk));
      started.stderr.on('data', (chunk) => (output += chunk));
      return started;
    };
    let child = launch();
    const stopped = () => new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once('exit', resolve)));

    const headers = (body: unknown) => ({
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(appEnv.ACCESS_TOKEN ? { Authorization: `Bearer ${appEnv.ACCESS_TOKEN}` } : {}),
    });
    const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
      const res = await fetch(`${url}/api${route}`, { method, headers: headers(body), body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(`${method} ${route} failed: ${json.error ?? res.status}`);
      return json as T;
    };
    const snapshot = () => api<Snapshot>('GET', '/snapshot');
    const light = async (name: string) => {
      const found = (await snapshot()).devices.find((d) => d.name === name);
      if (!found) throw new Error(`No light called ${name}`);
      return found;
    };

    // Ready once it answers and has found the simulated lights.
    const ready = () =>
      expect
        .poll(async () => (child.exitCode !== null ? 'exited' : await snapshot().then((s) => s.devices.length, () => 0)), { timeout: 20_000 })
        .toBe(8)
        .catch(() => {
          throw new Error(`The app did not start.\n${output}`);
        });

    try {
      await ready();
      await use({
        url,
        api,
        snapshot,
        light,
        colors: async (name) => {
          const d = await light(name);
          const a = d.state.appearance;
          return a.mode === 'segments' ? a.colors : a.mode === 'color' ? Array<RGB>(Math.max(1, d.caps.segments)).fill(a.rgb) : [];
        },
        restart: async (edit) => {
          // The app writes its data out when asked to stop.
          child.kill();
          await stopped();
          if (edit) {
            const file = path.join(dataDir, 'demo.json');
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            edit(data);
            fs.writeFileSync(file, JSON.stringify(data));
          }
          child = launch();
          await ready();
        },
        simulate: async (name, change) => void (await api('POST', '/demo/lights', { name, ...change })),
      });
    } finally {
      child.kill();
      await stopped();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },

  baseURL: async ({ app }, use) => {
    await use(app.url);
  },

  // Any uncaught error in the page fails the test, whatever else it was checking.
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await use(page);
    expect(errors, 'uncaught errors in the page').toEqual([]);
  },
});

export { expect };

/** Opens a section from the navigation and waits for it. */
export async function goTo(page: Page, section: 'Lights' | 'Looks' | 'Schedules' | 'Settings' | 'Help'): Promise<void> {
  await page.locator('.nav').getByRole('button', { name: section, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: section })).toBeVisible();
}

/** Presses at one point of an element and drags to another, both given as fractions of its size. */
export async function drag(page: Page, selector: string | ReturnType<Page['locator']>, from: [number, number], to: [number, number], steps = 10): Promise<void> {
  const target = typeof selector === 'string' ? page.locator(selector) : selector;
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps });
  await page.mouse.up();
}
