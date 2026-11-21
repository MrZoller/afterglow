import { useSyncExternalStore } from 'react';
import type { Action, ApplySummary, Device, Snapshot } from '../../shared/types';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

interface AppState {
  snap: Snapshot | null;
  session: 'loading' | 'login' | 'ready';
  /** Whether the live connection to the server is up. */
  live: boolean;
  toasts: Toast[];
}

let state: AppState = { snap: null, session: 'loading', live: false, toasts: [] };
const listeners = new Set<() => void>();

function set(patch: Partial<AppState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Selectors must return a value held in the state, not a freshly built one. */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const useSnap = () => useApp((s) => s.snap)!;

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  set({ toasts: [...state.toasts.slice(-2), { id, text, kind }] });
  setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6000 : 3500);
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach the Afterglow server');
  }
  if (res.status === 401 && path !== '/login') set({ session: 'login' });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

/** Runs a request and shows any failure as a toast. Resolves to undefined on failure. */
export async function attempt<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch (err) {
    toast((err as Error).message, 'error');
    return undefined;
  }
}

let source: EventSource | null = null;

function connect() {
  source?.close();
  const es = new EventSource('/api/events');
  source = es;
  es.addEventListener('snapshot', (e) => set({ snap: JSON.parse((e as MessageEvent).data), live: true, session: 'ready' }));
  es.addEventListener('patch', (e) => {
    if (state.snap) set({ snap: { ...state.snap, ...JSON.parse((e as MessageEvent).data) } });
  });
  es.onerror = () => {
    set({ live: false });
    // The browser retries by itself unless the server refused the connection outright.
    if (es.readyState === EventSource.CLOSED) setTimeout(start, 3000);
  };
}

export async function start() {
  try {
    const session = await api<{ authRequired: boolean; authed: boolean }>('GET', '/session');
    if (session.authRequired && !session.authed) set({ session: 'login' });
    else connect();
  } catch {
    setTimeout(start, 3000);
  }
}

export async function login(token: string): Promise<string | null> {
  try {
    await api('POST', '/login', { token });
    connect();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session === 'ready') void api('POST', '/refresh').catch(() => undefined);
});

/** The lights a target covers, in the order the server will take them: a zone's own order, then as listed. */
export function targetDevices(snap: Snapshot, targets: string[]): Device[] {
  const byId = new Map(snap.devices.map((d) => [d.id, d]));
  const out = new Map<string, Device>();
  const add = (id: string) => {
    const device = byId.get(id);
    if (device) out.set(id, device);
  };
  for (const t of targets) {
    if (t === 'all') snap.devices.forEach((d) => add(d.id));
    else if (t.startsWith('group:')) snap.groups.find((g) => g.id === t.slice(6))?.deviceIds.forEach(add);
    else add(t);
  }
  return [...out.values()];
}

/** Shows the obvious result at once instead of waiting for the server to echo it. */
function optimistic(targets: string[], action: Action) {
  const snap = state.snap;
  if (!snap || (action.type !== 'power' && action.type !== 'brightness')) return;
  const ids = new Set(targetDevices(snap, targets).map((d) => d.id));
  set({
    snap: {
      ...snap,
      devices: snap.devices.map((d) =>
        ids.has(d.id)
          ? { ...d, state: { ...d.state, ...(action.type === 'power' ? { power: action.on } : { brightness: action.value }) } }
          : d,
      ),
    },
  });
}

export async function control(targets: string[], action: Action): Promise<void> {
  optimistic(targets, action);
  const summary = await attempt(api<ApplySummary>('POST', '/control', { targets, action }));
  // Holding a moving look only concerns the lights that were moving.
  if (!summary?.skipped.length || action.type === 'still') return;
  const reasons = [...new Set(summary.skipped.map((s) => s.reason))].join(', ');
  toast(
    summary.applied.length
      ? `Skipped ${summary.skipped.length} light${summary.skipped.length === 1 ? '' : 's'}: ${reasons}`
      : `Nothing changed: ${reasons}`,
    summary.applied.length ? 'info' : 'error',
  );
}
