import os from 'node:os';
import express from 'express';
import type { Snapshot, Status } from '../shared/types';
import { aiEnabled } from './ai';
import { config } from './config';
import { GoveeCloud } from './govee/cloud';
import { startFakeGovee } from './govee/fake';
import { Hub } from './hub';
import { createApi, Events, requireAuth, sameOrigin, staticApp, type Services } from './http';
import { mcpHandler } from './mcp';
import { Ops } from './ops';
import { Scheduler, sunTimes } from './scheduler';
import { Store } from './store';

async function main() {
  // Demo data lives in its own file so it never mixes with the real lights.
  const store = new Store(config.dataDir, config.demo ? 'demo.json' : 'afterglow.json');

  const baseUrl = config.demo ? (await startFakeGovee()).url : config.apiBase;
  const cloud = new GoveeCloud({ apiKey: config.demo ? 'demo' : config.apiKey, baseUrl, onRequest: () => store.countRequest() });
  const hub = new Hub(cloud, store);

  const status = (): Status => {
    const loc = store.data.settings.location;
    const sun = loc ? sunTimes(new Date(), loc) : null;
    return {
      mode: config.demo ? 'demo' : 'cloud',
      connected: hub.connected,
      error: hub.error,
      requestsToday: store.requestsToday(),
      dailyLimit: cloud.limits.dailyLimit,
      dailyRemaining: cloud.limits.dailyRemaining,
      sun: sun ? { sunrise: sun.sunrise.getTime(), sunset: sun.sunset.getTime() } : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      authRequired: !!config.accessToken,
      ai: aiEnabled(),
      version: config.version,
    };
  };

  let scheduler!: Scheduler;
  const snapshot = (): Snapshot => ({
    devices: hub.list(),
    groups: store.data.groups,
    looks: store.data.looks,
    schedules: scheduler.views(),
    settings: store.data.settings,
    status: status(),
    activity: store.data.activity.slice(0, 50),
  });
  const events = new Events(snapshot);
  scheduler = new Scheduler(store, hub, () => events.changed('schedules'));
  const ops = new Ops(store, hub, (...kinds) => events.changed(...kinds));
  const services: Services = { hub, ops, scheduler, snapshot };

  hub.on('devices', () => events.changed('devices'));
  hub.on('status', () => events.changed('status'));
  hub.on('activity', () => events.changed('activity'));
  // "Next run" times drift as the day goes on; refresh them for open pages.
  setInterval(() => events.changed('schedules', 'status'), 60_000).unref();

  await hub.start();
  if (config.demo) seedDemo(store, hub, ops);
  scheduler.start();

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createApi(services, events));
  app.use('/mcp', sameOrigin, express.json({ limit: '1mb' }), requireAuth, mcpHandler(services));
  app.use(...staticApp());

  app.listen(config.port, config.host, () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => `http://${n!.address}:${config.port}`);
    console.log(`Afterglow ${config.version} is running${config.demo ? ' in demo mode (simulated lights)' : ''}`);
    console.log(`  This computer:  http://localhost:${config.port}`);
    if (config.host === '0.0.0.0' && lan.length) console.log(`  Your network:   ${lan.join('  ')}`);
    console.log(`  MCP endpoint:   http://localhost:${config.port}/mcp`);
    if (!config.demo && !hub.connected) console.log(`  Govee problem:  ${hub.error}`);
  });

  const stop = () => {
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** Gives demo mode zones and schedules so there is something to look at. */
function seedDemo(store: Store, hub: Hub, ops: Ops) {
  if (store.data.groups.length || store.data.schedules.length) return;
  const devices = hub.list();
  const ids = (match: (name: string) => boolean) => devices.filter((d) => match(d.name)).map((d) => d.id);
  const front = ops.saveGroup({ name: 'Front yard', deviceIds: ids((n) => /front|driveway|flower/i.test(n)) });
  ops.saveGroup({ name: 'Back yard', deviceIds: ids((n) => /patio|deck|back|side/i.test(n)) });
  ops.updateSettings({ location: { lat: 39.74, lon: -104.99, label: 'Denver (demo)' } });
  ops.saveSchedule({ name: 'Evening glow', days: [0, 1, 2, 3, 4, 5, 6], start: { type: 'sun', event: 'sunset', offsetMin: -15 }, end: { type: 'clock', time: '23:00' }, targets: ['all'], action: { type: 'look', lookId: 'starter-warm' } });
  ops.saveSchedule({ name: 'Holiday lights', days: [0, 1, 2, 3, 4, 5, 6], start: { type: 'sun', event: 'sunset', offsetMin: 0 }, end: { type: 'clock', time: '00:30' }, season: { from: '12-01', to: '01-06' }, targets: [`group:${front.id}`], action: { type: 'look', lookId: 'starter-holiday' } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
