import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { Snapshot } from '../shared/types';
import { config } from './config';
import { GoveeError } from './govee/cloud';
import { HttpError, type Hub } from './hub';
import { controlSchema, type Ops } from './ops';
import type { Scheduler } from './scheduler';

export interface Services {
  hub: Hub;
  ops: Ops;
  scheduler: Scheduler;
  snapshot(): Snapshot;
}

const COOKIE = 'afterglow_session';

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The cookie holds a value derived from the passphrase, never the passphrase itself. */
const sessionValue = () => createHmac('sha256', config.accessToken).update('afterglow-session').digest('hex');

function isAuthed(req: Request): boolean {
  if (!config.accessToken) return true;
  const bearer = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
  if (bearer && same(bearer[1], config.accessToken)) return true;
  const cookie = (req.header('cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return !!cookie && same(cookie.slice(COOKIE.length + 1), sessionValue());
}

const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.ts.net'];
const extraHosts = (process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

/** True for the names a home server is normally reached by: IP addresses and local hostnames. */
export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().replace(/:\d+$/, '');
  if (host.startsWith('[')) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (!host.includes('.')) return true; // "localhost", "mac-mini"
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)) || extraHosts.includes(host);
}

/**
 * Keeps other websites from reaching this server through the browser: requests must be
 * addressed to a local name (which defeats DNS rebinding) and, when they change
 * something, must come from this app's own pages.
 */
export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalHost(req.header('host'))) {
    res.status(403).json({ error: 'This address is not allowed. Add it to ALLOWED_HOSTS in .env to use it.' });
    return;
  }
  const origin = req.header('origin');
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      // A malformed Origin is treated as foreign.
    }
    if (host !== req.header('host')) {
      res.status(403).json({ error: 'Cross-site requests are not allowed' });
      return;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthed(req)) next();
  else res.status(401).json({ error: 'Passphrase required' });
}

/** Pushes changed parts of the snapshot to every open page. */
export class Events {
  private clients = new Set<Response>();
  private dirty = new Set<keyof Snapshot>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private snapshot: () => Snapshot) {}

  attach(req: Request, res: Response): void {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`event: snapshot\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  changed(...kinds: (keyof Snapshot)[]): void {
    kinds.forEach((k) => this.dirty.add(k));
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.clients.size === 0) {
        this.dirty.clear();
        return;
      }
      const snap = this.snapshot();
      const patch = Object.fromEntries([...this.dirty].map((k) => [k, snap[k]]));
      this.dirty.clear();
      const frame = `event: patch\ndata: ${JSON.stringify(patch)}\n\n`;
      for (const client of this.clients) client.write(frame);
    }, 40);
  }
}

export function createApi(services: Services, events: Events): express.Router {
  const { hub, ops, scheduler } = services;
  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  api.use(sameOrigin);

  api.get('/session', (req, res) => {
    res.json({ authRequired: !!config.accessToken, authed: isAuthed(req) });
  });

  api.post('/login', (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!config.accessToken || !same(token, config.accessToken)) {
      res.status(401).json({ error: 'That passphrase is not right' });
      return;
    }
    res.cookie(COOKIE, sessionValue(), { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000, path: '/' });
    res.json({ ok: true });
  });

  api.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  api.use(requireAuth);

  api.get('/snapshot', (_req, res) => {
    res.json(services.snapshot());
  });

  api.get('/events', (req, res) => events.attach(req, res));

  api.post('/control', async (req, res) => {
    const { targets, action } = controlSchema.parse(req.body);
    const { summary } = await hub.apply(targets, action, 'app');
    res.json(summary);
  });

  /** Re-reads state from Govee; the page calls this when it becomes visible. */
  api.post('/refresh', async (_req, res) => {
    await hub.refresh(undefined, 60_000);
    res.json({ ok: true });
  });

  api.post('/rescan', async (_req, res) => {
    await hub.discover();
    await hub.refresh();
    res.json({ ok: true });
  });

  api.patch('/devices/:id', (req, res) => {
    const { name } = z.object({ name: z.string().trim().max(60).nullable() }).parse(req.body);
    hub.rename(req.params.id, name);
    res.json({ ok: true });
  });

  api.get('/scenes', async (req, res) => {
    const targets = String(req.query.targets ?? '').split(',').filter(Boolean);
    if (targets.length === 0) throw new HttpError(400, 'No lights given');
    res.json(await hub.scenes(targets, req.query.reload === '1'));
  });

  api.post('/looks', (req, res) => void res.json(ops.saveLook(req.body)));
  api.put('/looks/:id', (req, res) => void res.json(ops.saveLook(req.body, req.params.id)));
  api.delete('/looks/:id', (req, res) => {
    ops.deleteLook(req.params.id);
    res.json({ ok: true });
  });

  api.post('/schedules', (req, res) => void res.json(scheduler.view(ops.saveSchedule(req.body))));
  api.put('/schedules/:id', (req, res) => void res.json(scheduler.view(ops.saveSchedule(req.body, req.params.id))));
  api.patch('/schedules/:id', (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(scheduler.view(ops.setScheduleEnabled(req.params.id, enabled)));
  });
  api.delete('/schedules/:id', (req, res) => {
    ops.deleteSchedule(req.params.id);
    res.json({ ok: true });
  });
  api.post('/schedules/:id/run', async (req, res) => {
    const schedule = services.snapshot().schedules.find((s) => s.id === req.params.id);
    if (!schedule) throw new HttpError(404, 'Schedule not found');
    const { summary } = await hub.apply(schedule.targets, schedule.action, 'app');
    res.json(summary);
  });

  api.post('/groups', (req, res) => void res.json(ops.saveGroup(req.body)));
  api.put('/groups/:id', (req, res) => void res.json(ops.saveGroup(req.body, req.params.id)));
  api.delete('/groups/:id', (req, res) => {
    ops.deleteGroup(req.params.id);
    res.json({ ok: true });
  });

  api.put('/settings', (req, res) => void res.json(ops.updateSettings(req.body)));

  api.use((_req, res) => void res.status(404).json({ error: 'Not found' }));

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      res.status(400).json({ error: `${issue.path.join('.') || 'request'}: ${issue.message}` });
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof GoveeError) {
      res.status(502).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Something went wrong on the server' });
    }
  });

  return api;
}

/** Serves the built web app, falling back to index.html for in-app routes. */
export function staticApp(): express.RequestHandler[] {
  const index = path.join(config.webDir, 'index.html');
  if (!fs.existsSync(index)) {
    return [
      (req, res, next) => {
        if (req.method !== 'GET') return next();
        res.type('text/plain').send('The web app has not been built yet. Run "npm run build", or "npm run dev" and open http://localhost:5173.');
      },
    ];
  }
  return [
    express.static(config.webDir, { index: false, maxAge: '1h' }),
    (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.set('Cache-Control', 'no-cache').sendFile(index);
    },
  ];
}
