import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root: one level above both `server/` (dev) and `dist/` (built). */
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // No .env file: fall back to the process environment and demo mode.
}

const env = (name: string) => process.env[name]?.trim() ?? '';

const apiKey = env('GOVEE_API_KEY');

export const config = {
  apiKey,
  apiBase: env('GOVEE_API_BASE') || 'https://openapi.api.govee.com',
  /** Demo mode runs against simulated lights. */
  demo: !apiKey || env('DEMO') === '1',
  port: Number(env('PORT')) || 4680,
  host: env('HOST') || '0.0.0.0',
  accessToken: env('ACCESS_TOKEN'),
  /** Talk to lights directly over the local network where possible. Set LAN=0 to use the cloud only. */
  lan: env('LAN') !== '0',
  dataDir: env('DATA_DIR') || path.join(root, 'data'),
  webDir: path.join(root, 'dist', 'web'),
  version: '0.1.0',
};
