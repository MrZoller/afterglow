import { EventEmitter } from 'node:events';
import { kelvinToRgb, toHex } from '../shared/color';
import { canMove, groupByColor, placeColors, placedCost, placedStepSeconds, placeLights, renderPlaced, type Placement } from '../shared/looks';
import type { Action, ApplySummary, Device, DeviceKind, DeviceState, Look, RGB, SceneChoice, Source } from '../shared/types';
import { Animator } from './animator';
import { GoveeError, type CloudState, type Command, type DeviceInfo, type GoveeCloud, type SceneOption } from './govee/cloud';
import { isLanCommand, type GoveeLan, type LanCommand } from './govee/lan';
import { CommandQueue } from './queue';
import type { Store } from './store';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Entry {
  info: DeviceInfo;
  alias: string | null;
  state: DeviceState;
  /** Mounted with its last segment where designs should start. */
  reversed?: boolean;
  error: string | null;
  /**
   * Colour last read from the cloud and from the light itself, used to notice changes made
   * outside this app. Kept apart because the two can describe the same state differently.
   */
  lastCloud?: { rgb: RGB | null; kelvin: number | null };
  lastLan?: { rgb: RGB | null; kelvin: number | null };
}

interface Plan {
  cmds: Command[];
  patch: (state: DeviceState) => void;
}

export interface ApplyResult {
  summary: ApplySummary;
  /** Settles once every command has been sent or has failed. */
  done: Promise<{ failed: { deviceId: string; name: string; error: string }[] }>;
}

const KINDS: Record<string, DeviceKind> = { H61A8: 'rope', H61A9: 'rope', H7086: 'garden' };
const DAY_MS = 24 * 60 * 60 * 1000;

const blankState = (): DeviceState => ({
  online: null,
  power: null,
  brightness: null,
  appearance: { mode: 'unknown' },
  lookId: null,
  updatedAt: 0,
  syncedAt: null,
});

const slotOf = (cmd: Command): string =>
  cmd.cap === 'power' ? 'power' : cmd.cap === 'brightness' ? 'brightness' : cmd.cap === 'toggle' ? `toggle:${cmd.instance}` : 'appearance';

const sceneKey = (s: { kind: string; name: string }) => `${s.kind}:${s.name.toLowerCase()}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Owns the list of lights, their last known state, and everything sent to them. */
export class Hub extends EventEmitter {
  connected = false;
  error: string | null = null;

  /** Moving looks in progress. */
  readonly animator: Animator;

  private entries = new Map<string, Entry>();
  private queue: CommandQueue;
  private sceneFetches = new Map<string, Promise<SceneOption[]>>();
  private lastRefresh = new Map<string, number>();

  /** Pause between a local command and the status query that confirms the light is answering. */
  confirmDelayMs = 120;

  constructor(
    private cloud: GoveeCloud,
    private store: Store,
    /** Local network control, when available. Simple commands prefer it over the cloud. */
    private lan: GoveeLan | null = null,
  ) {
    super();
    lan?.on('change', () => this.emit('devices'));
    this.queue = new CommandQueue({ burst: 5, perSecond: 1, maxAttempts: 4, onChange: () => this.emit('devices') });
    for (const d of store.data.devices) this.entries.set(d.info.id, { ...d, error: null });
    this.animator = new Animator(store, {
      plan: (look, light) => {
        const e = this.entries.get(light.id);
        if (!e) return null;
        const placement: Placement = { segments: e.info.caps.segments, index: light.index, offset: light.offset, total: light.total, reversed: e.reversed };
        // A frame can go locally only when it is a single colour for the whole light.
        const local = !!this.lan?.has(light.id) && placedCost(look, placement) === 1;
        return { placement, local, stepSeconds: placedStepSeconds(look, placement, local) };
      },
      paint: (id, colors) => this.paintFrame(id, colors),
      // Leave headroom under the daily limit for ordinary use and schedules.
      overBudget: () => store.requestsToday() >= (cloud.limits.dailyLimit ?? 10_000) * 0.85,
      note: (text) => {
        store.log({ source: 'schedule', ok: false, text });
        this.emit('activity');
      },
      changed: () => this.emit('devices'),
    });
  }

  async start(): Promise<void> {
    // The failure is kept in this.error; keep trying in case the network was not up yet.
    const attempt = async (delayMs: number): Promise<void> => {
      try {
        await this.discover();
        void this.refresh();
      } catch {
        setTimeout(() => void attempt(Math.min(delayMs * 2, 10 * 60_000)), delayMs).unref();
      }
    };
    await attempt(30_000);
    setInterval(() => void this.refresh(), 10 * 60_000).unref();
    // Asking the lights directly is free, so do it often enough to notice changes made elsewhere.
    setInterval(() => void this.refreshLocal(), 30_000).unref();
    this.animator.start();
  }

  /** Lights in the order the user arranged them; ones they have not placed come last. */
  private ordered(): Entry[] {
    const rank = new Map(this.store.data.order.map((id, i) => [id, i]));
    return [...this.entries.values()].sort((a, b) => (rank.get(a.info.id) ?? Infinity) - (rank.get(b.info.id) ?? Infinity));
  }

  list(): Device[] {
    return this.ordered().map((e) => this.view(e));
  }

  private view(e: Entry): Device {
    return {
      id: e.info.id,
      sku: e.info.sku,
      name: e.alias ?? e.info.goveeName,
      goveeName: e.info.goveeName,
      kind: KINDS[e.info.sku] ?? 'light',
      caps: e.info.caps,
      state: e.state,
      moving: this.animator.has(e.info.id),
      local: !!this.lan?.has(e.info.id),
      reversed: !!e.reversed,
      pending: this.queue.pending(e.info.id),
      error: e.error,
    };
  }

  private persist(): void {
    this.store.data.devices = [...this.entries.values()].map(({ info, alias, state, reversed }) => ({ info, alias, state, ...(reversed ? { reversed } : {}) }));
    this.store.save();
  }

  /** Reads the list of lights from the Govee account. */
  async discover(): Promise<void> {
    try {
      const infos = await this.cloud.listDevices();
      for (const info of infos) {
        const existing = this.entries.get(info.id);
        if (existing) existing.info = info;
        else this.entries.set(info.id, { info, alias: null, state: blankState(), error: null });
      }
      // An empty answer is more likely a hiccup than every light being removed.
      if (infos.length) {
        const seen = new Set(infos.map((i) => i.id));
        for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.entries.delete(id);
      }
      this.connected = true;
      this.error = null;
    } catch (err) {
      this.connected = false;
      this.error = (err as Error).message;
      throw err;
    } finally {
      this.persist();
      this.emit('devices');
      this.emit('status');
    }
  }

  /** Reads state back from Govee. Lights refreshed within `minAgeMs` are skipped. */
  async refresh(ids?: string[], minAgeMs = 0): Promise<void> {
    const targets = (ids ?? [...this.entries.keys()]).map((id) => this.entries.get(id)).filter((e): e is Entry => !!e);
    await Promise.all(
      targets.map(async (e) => {
        const id = e.info.id;
        const now = Date.now();
        if (this.queue.pending(id) > 0 || now - e.state.updatedAt < 5_000) return; // our own change is still landing
        if (now - (this.lastRefresh.get(id) ?? 0) < minAgeMs) return;
        this.lastRefresh.set(id, now);
        try {
          // Ask the light itself when it is reachable; that costs no cloud request.
          const local = this.lan?.has(id) ? await this.lan.status(id) : null;
          const seen = local ?? (await this.cloud.getState(e.info));
          if (this.queue.pending(id) > 0) return;
          this.merge(e, seen, local ? 'lan' : 'cloud');
          if (!local) {
            this.connected = true;
            this.error = null;
          }
        } catch (err) {
          if (err instanceof GoveeError && (err.status === 0 || err.status === 401)) {
            this.connected = false;
            this.error = err.message;
          }
        }
      }),
    );
    this.persist();
    this.emit('devices');
    this.emit('status');
  }

  /** Reads state straight from the lights that answer locally. */
  private async refreshLocal(): Promise<void> {
    if (!this.lan) return;
    let changed = false;
    await Promise.all(
      this.lan.reachable().map(async (id) => {
        const e = this.entries.get(id);
        if (!e || this.queue.pending(id) > 0 || Date.now() - e.state.updatedAt < 5_000) return;
        const seen = await this.lan!.status(id);
        if (!seen || this.queue.pending(id) > 0) return;
        const snapshot = () => JSON.stringify([e.state.online, e.state.power, e.state.brightness, e.state.appearance]);
        const before = snapshot();
        this.merge(e, seen, 'lan');
        if (snapshot() !== before) changed = true;
      }),
    );
    if (changed) {
      this.persist();
      this.emit('devices');
    }
  }

  private merge(e: Entry, cloud: CloudState, source: 'cloud' | 'lan' = 'cloud'): void {
    const st = e.state;
    if (cloud.online !== null) st.online = cloud.online;
    if (cloud.power !== null) st.power = cloud.power;
    // Switched off somewhere else: stop sending it colours.
    if (cloud.power === false) this.animator.release([e.info.id]);
    if (cloud.brightness !== null) st.brightness = cloud.brightness;
    // Govee does not report segments or scenes, so what we last applied stays on screen
    // unless the colour it does report has changed, meaning someone used another app.
    const key = source === 'lan' ? 'lastLan' : 'lastCloud';
    const before = e[key];
    // While a scene plays, the colour a light reports for itself may wander, so it proves nothing.
    const reliable = !(source === 'lan' && st.appearance.mode === 'scene');
    const changedElsewhere = reliable && !!before && (before.rgb !== cloud.rgb || before.kelvin !== cloud.kelvin);
    if (st.appearance.mode === 'unknown' || changedElsewhere) {
      if (cloud.kelvin) st.appearance = { mode: 'temp', kelvin: cloud.kelvin };
      else if (cloud.rgb !== null) st.appearance = { mode: 'color', rgb: cloud.rgb };
      st.lookId = null;
    }
    e[key] = { rgb: cloud.rgb, kelvin: cloud.kelvin };
    st.syncedAt = Date.now();
  }

  /** Changes a light's name in this app, or which way round it is mounted. */
  update(id: string, change: { name?: string | null; reversed?: boolean }): void {
    const e = this.entries.get(id);
    if (!e) throw new HttpError(404, 'Light not found');
    if (change.name !== undefined) e.alias = change.name?.trim() || null;
    if (change.reversed !== undefined) e.reversed = change.reversed;
    this.persist();
    this.emit('devices');
  }

  /** Sets the order lights are listed in, which is also the order colours are handed out. */
  setOrder(ids: string[]): void {
    this.store.data.order = ids.filter((id) => this.entries.has(id));
    this.store.save();
    this.emit('devices');
  }

  /** Expands "all", "group:<id>" and device ids into lights, in order, without duplicates. */
  private resolve(targets: string[]): Entry[] {
    const out = new Map<string, Entry>();
    const add = (id: string) => {
      const e = this.entries.get(id);
      if (e) out.set(id, e);
    };
    for (const target of targets) {
      if (target === 'all') for (const e of this.ordered()) add(e.info.id);
      else if (target.startsWith('group:')) {
        const group = this.store.data.groups.find((g) => g.id === target.slice(6));
        for (const id of group?.deviceIds ?? []) add(id);
      } else add(target);
    }
    return [...out.values()];
  }

  deviceIds(targets: string[]): string[] {
    return this.resolve(targets).map((e) => e.info.id);
  }

  describeTargets(targets: string[]): string {
    if (targets.includes('all')) return 'All lights';
    const names = targets.map((t) => {
      if (t.startsWith('group:')) return this.store.data.groups.find((g) => g.id === t.slice(6))?.name;
      const e = this.entries.get(t);
      return e ? (e.alias ?? e.info.goveeName) : undefined;
    });
    const known = names.filter((n): n is string => !!n);
    if (known.length === 0) return 'No lights';
    return known.length <= 2 ? known.join(' and ') : `${known[0]}, ${known[1]} and ${known.length - 2} more`;
  }

  describeAction(action: Action): string {
    switch (action.type) {
      case 'power':
        return action.on ? 'turned on' : 'turned off';
      case 'brightness':
        return `brightness ${action.value}%`;
      case 'color':
        return `colour ${toHex(action.rgb)}`;
      case 'colorTemp':
        return `white ${action.kelvin}K`;
      case 'segments':
        return 'painted segments';
      case 'scene':
        return `scene "${action.scene.name}"`;
      case 'look':
        return `look "${this.store.data.looks.find((l) => l.id === action.lookId)?.name ?? 'deleted look'}"`;
      case 'palette':
        return 'custom colours';
      case 'still':
        return 'held the current colours';
      case 'toggle':
        return `${action.instance} ${action.on ? 'on' : 'off'}`;
    }
  }

  private async sceneOptions(e: Entry, force = false): Promise<SceneOption[]> {
    const sku = e.info.sku;
    const cached = this.store.data.scenes[sku];
    let fetched = cached?.options ?? [];
    if (!cached || force || Date.now() - cached.at > DAY_MS) {
      let pending = this.sceneFetches.get(sku);
      if (!pending) {
        pending = this.cloud.getScenes(e.info).finally(() => this.sceneFetches.delete(sku));
        this.sceneFetches.set(sku, pending);
      }
      try {
        fetched = await pending;
        this.store.data.scenes[sku] = { at: Date.now(), options: fetched };
        this.store.save();
      } catch (err) {
        if (!cached) throw err; // nothing to fall back on
      }
    }
    const hasLight = fetched.some((o) => o.kind === 'light');
    const listed = e.info.listedScenes.filter((o) => o.kind !== 'light' || !hasLight);
    const seen = new Set<string>();
    return [...fetched, ...listed].filter((o) => !seen.has(sceneKey(o)) && !!seen.add(sceneKey(o)));
  }

  /** Scenes offered by the given lights, with how many of them support each. */
  async scenes(targets: string[], force = false): Promise<{ scenes: SceneChoice[]; lights: number }> {
    const entries = this.resolve(targets);
    const lists = await Promise.all(entries.map((e) => this.sceneOptions(e, force)));
    const merged = new Map<string, SceneChoice>();
    for (const list of lists) {
      for (const option of list) {
        const key = sceneKey(option);
        const existing = merged.get(key);
        if (existing) existing.supported += 1;
        else merged.set(key, { kind: option.kind, name: option.name, supported: 1 });
      }
    }
    return { scenes: [...merged.values()], lights: entries.length };
  }

  private async plan(e: Entry, action: Action, place: Placement, look: Look | undefined, wake: boolean): Promise<Plan | { skip: string }> {
    const caps = e.info.caps;
    const on: Command[] = wake || e.state.power !== true ? [{ cap: 'power', on: true }] : [];
    const shown = (st: DeviceState) => {
      st.power = true;
      st.lookId = null;
    };
    const paint = (colors: RGB[]): { cmds: Command[]; appearance: DeviceState['appearance'] } => {
      const groups = groupByColor(colors);
      if (groups.length === 1 || !caps.segments) {
        return { cmds: [{ cap: 'color', rgb: groups[0].rgb }], appearance: { mode: 'color', rgb: groups[0].rgb } };
      }
      return {
        cmds: groups.map((g) => ({ cap: 'segmentColor', segments: g.segments, rgb: g.rgb })),
        appearance: { mode: 'segments', colors },
      };
    };
    const clampBrightness = (value: number) => {
      const range = caps.brightness ?? { min: 1, max: 100 };
      return Math.max(range.min, Math.min(range.max, Math.round(value)));
    };

    switch (action.type) {
      case 'power':
        return { cmds: [{ cap: 'power', on: action.on }], patch: (st) => void (st.power = action.on) };

      case 'brightness': {
        if (!caps.brightness) return { skip: 'no brightness control' };
        const value = clampBrightness(action.value);
        return { cmds: [{ cap: 'brightness', value }], patch: (st) => void (st.brightness = value) };
      }

      case 'color':
        if (!caps.color) return { skip: 'no colour control' };
        return {
          cmds: [...on, { cap: 'color', rgb: action.rgb }],
          patch: (st) => {
            shown(st);
            st.appearance = { mode: 'color', rgb: action.rgb };
          },
        };

      case 'colorTemp': {
        if (!caps.colorTemp && !caps.color) return { skip: 'no white control' };
        const kelvin = caps.colorTemp ? Math.max(caps.colorTemp.min, Math.min(caps.colorTemp.max, Math.round(action.kelvin))) : action.kelvin;
        const cmd: Command = caps.colorTemp ? { cap: 'colorTemp', kelvin } : { cap: 'color', rgb: kelvinToRgb(kelvin) };
        return {
          cmds: [...on, cmd],
          patch: (st) => {
            shown(st);
            st.appearance = { mode: 'temp', kelvin };
          },
        };
      }

      case 'segments': {
        if (!caps.color) return { skip: 'no colour control' };
        if (action.colors.length === 0) return { skip: 'no colours given' };
        const painted = paint(placeColors(action.colors, place));
        return {
          cmds: [...on, ...painted.cmds],
          patch: (st) => {
            shown(st);
            st.appearance = painted.appearance;
          },
        };
      }

      case 'look':
      case 'palette': {
        if (!look) return { skip: 'look not found' };
        if (!caps.color) return { skip: 'no colour control' };
        const painted = paint(renderPlaced(look, place));
        const brightness = look.brightness !== null && caps.brightness ? clampBrightness(look.brightness) : null;
        return {
          cmds: [...on, ...(brightness !== null ? [{ cap: 'brightness', value: brightness } as Command] : []), ...painted.cmds],
          patch: (st) => {
            shown(st);
            st.appearance = painted.appearance;
            st.lookId = action.type === 'look' ? look.id : null;
            if (brightness !== null) st.brightness = brightness;
          },
        };
      }

      case 'still':
        if (!this.animator.has(e.info.id)) return { skip: 'not moving' };
        return { cmds: [], patch: () => undefined };

      case 'scene': {
        const options = await this.sceneOptions(e);
        const match = options.find((o) => sceneKey(o) === sceneKey(action.scene));
        if (!match) return { skip: `no scene called "${action.scene.name}"` };
        return {
          cmds: [...on, { cap: 'scene', kind: match.kind, value: match.value }],
          patch: (st) => {
            shown(st);
            st.appearance = { mode: 'scene', scene: { kind: match.kind, name: match.name } };
          },
        };
      }

      case 'toggle':
        if (!caps.toggles.includes(action.instance)) return { skip: `no ${action.instance}` };
        return { cmds: [{ cap: 'toggle', instance: action.instance, on: action.on }], patch: () => undefined };
    }
  }

  /**
   * Applies an action to the targets. State is updated straight away; the commands go
   * out through the queue, and failures surface on the device and in the activity log.
   */
  async apply(targets: string[], action: Action, source: Source): Promise<ApplyResult> {
    const entries = this.resolve(targets);
    if (entries.length === 0) throw new HttpError(400, 'No lights match those targets');
    const look: Look | undefined =
      action.type === 'look'
        ? this.store.data.looks.find((l) => l.id === action.lookId)
        : action.type === 'palette'
          ? { ...action, id: '', name: '', createdAt: 0, updatedAt: 0 }
          : undefined;
    if (action.type === 'look' && !look) throw new HttpError(404, 'That look no longer exists');

    // Lights joined end to end share one design, so each light's share depends on what else is targeted.
    const places = placeLights(
      entries.map((e) => ({ id: e.info.id, segments: e.info.caps.segments, reversed: !!e.reversed })),
      this.store.data.groups,
      (id) => this.entries.has(id),
    );
    const plans = await Promise.all(
      entries.map((e) =>
        this.plan(e, action, places.get(e.info.id)!, look, source !== 'app').catch((err): { skip: string } => ({ skip: (err as Error).message })),
      ),
    );

    const summary: ApplySummary = { applied: [], skipped: [] };
    const failed: { deviceId: string; name: string; error: string }[] = [];
    const jobs: Promise<unknown>[] = [];

    entries.forEach((e, i) => {
      const plan = plans[i];
      const id = e.info.id;
      const name = e.alias ?? e.info.goveeName;
      if ('skip' in plan) {
        summary.skipped.push({ deviceId: id, name, reason: plan.skip });
        return;
      }
      const slots = new Set(plan.cmds.map(slotOf));
      // Switching off also abandons colour changes that have not gone out yet.
      if (action.type === 'power' && !action.on) ['appearance', 'brightness'].forEach((s) => slots.add(s));
      this.queue.cancel(id, [...slots]);

      plan.patch(e.state);
      e.state.updatedAt = Date.now();
      if (slots.has('appearance')) e.lastCloud = e.lastLan = undefined;
      summary.applied.push(id);

      let reported = false;
      for (const cmd of plan.cmds) {
        jobs.push(
          this.queue
            .push(id, slotOf(cmd), () => this.deliver(e, cmd), this.goesLocal(e, cmd))
            .then(
              () => {
                if (e.error) {
                  e.error = null;
                  this.emit('devices');
                }
              },
              (err: Error) => {
                e.error = err.message;
                if (!reported) {
                  reported = true;
                  failed.push({ deviceId: id, name, error: err.message });
                  this.store.log({ source, ok: false, text: `${name}: could not apply ${this.describeAction(action)}`, detail: err.message });
                  this.emit('activity');
                  // Read the real state back so the screen stops showing what did not happen.
                  setTimeout(() => void this.refreshAfterFailure(id), 2_000).unref();
                }
                this.emit('devices');
              },
            ),
        );
      }
    });

    // A moving look takes over the lights it was applied to; anything else that changes
    // how a light looks, or switches it off, ends the movement there.
    const applied = entries.flatMap((e, i) => {
      if ('skip' in plans[i]) return [];
      const { index, offset, total } = places.get(e.info.id)!;
      return [{ id: e.info.id, index, offset, total }];
    });
    const endsMovement = ['color', 'colorTemp', 'segments', 'scene', 'look', 'palette', 'still'].includes(action.type) || (action.type === 'power' && !action.on);
    if (look?.motion && canMove(look) && applied.length) this.animator.begin({ ...look, motion: look.motion }, applied);
    else if (endsMovement) this.animator.release(applied.map((l) => l.id));

    if (summary.applied.length) {
      const skipped = summary.skipped.length ? `${summary.skipped.length} skipped` : undefined;
      this.store.log({ source, ok: true, text: `${this.describeTargets(targets)}: ${this.describeAction(action)}`, detail: skipped });
      this.emit('activity');
    }
    this.persist();
    this.emit('devices');

    const done = Promise.all(jobs).then(() => {
      this.persist();
      this.emit('status');
      return { failed };
    });
    return { summary, done };
  }

  private goesLocal(e: Entry, cmd: Command): boolean {
    return !!this.lan && isLanCommand(cmd) && this.lan.has(e.info.id);
  }

  /** Sends over the local network when the light and the command allow it, otherwise through the cloud. */
  private async deliver(e: Entry, cmd: Command): Promise<void> {
    if (this.goesLocal(e, cmd) && (await this.sendLocal(e, cmd as LanCommand))) return;
    await this.cloud.send(e.info, cmd);
  }

  /**
   * Local commands are UDP and come with no receipt, so one counts as delivered when the
   * light answers a status query straight after it. A light that stays silent is left to
   * the cloud until it shows up on the network again.
   */
  private async sendLocal(e: Entry, cmd: LanCommand): Promise<boolean> {
    const lan = this.lan!;
    const id = e.info.id;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await lan.command(id, cmd);
      } catch {
        break;
      }
      await sleep(this.confirmDelayMs);
      const seen = await lan.status(id);
      if (!seen) continue;
      // Power and brightness read back exactly, so a mismatch means the command was lost: send it once more.
      const landed = cmd.cap === 'power' ? seen.power === cmd.on : cmd.cap === 'brightness' ? seen.brightness === cmd.value : true;
      if (landed || attempt === 1) return true;
    }
    lan.forget(id);
    return false;
  }

  /** Shows one frame of a moving look. Quieter than apply(): no power, no log entry. */
  private async paintFrame(id: string, colors: RGB[]): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e || colors.length === 0) return false;
    const groups = groupByColor(colors);
    const single = groups.length === 1 || !e.info.caps.segments;
    const appearance: DeviceState['appearance'] = single ? { mode: 'color', rgb: groups[0].rgb } : { mode: 'segments', colors };
    // Nothing to send when this step lands on the colours already showing.
    if (JSON.stringify(appearance) === JSON.stringify(e.state.appearance)) return true;

    const cmds: Command[] = single ? [{ cap: 'color', rgb: groups[0].rgb }] : groups.map((g) => ({ cap: 'segmentColor', segments: g.segments, rgb: g.rgb }));
    this.queue.cancel(id, ['appearance']);
    e.state.appearance = appearance;
    e.state.updatedAt = Date.now();
    e.lastCloud = e.lastLan = undefined;
    this.emit('devices');

    const results = await Promise.allSettled(cmds.map((cmd) => this.queue.push(id, 'appearance', () => this.deliver(e, cmd), this.goesLocal(e, cmd))));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    e.error = failure ? (failure.reason as Error).message : null;
    this.persist();
    this.emit('devices');
    return !failure;
  }

  private async refreshAfterFailure(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    e.state.updatedAt = 0;
    e.state.appearance = { mode: 'unknown' };
    await this.refresh([id]);
  }
}
