import { motionStepSeconds, renderLook } from '../shared/looks';
import type { Look, RGB } from '../shared/types';
import type { Store } from './store';

/**
 * Runs moving looks: every so often it works out how far round its loop each one is and
 * sends the lights their next colours. A light leaves its animation as soon as anything
 * else is applied to it.
 */

export interface StoredAnimation {
  id: string;
  /** A copy of the look as it was when applied, so later edits do not change it mid-run. */
  look: Pick<Look, 'colors' | 'pattern' | 'segments'> & { motion: NonNullable<Look['motion']>; name: string };
  startedAt: number;
  stepSeconds: number;
  nextAt: number;
  /** `index` is the light's position among the lights the look was applied to. */
  lights: { id: string; index: number }[];
}

export interface AnimationHost {
  /** Segment count of a light, or null when the light no longer exists. */
  segments(deviceId: string): number | null;
  /** Shows a frame on a light; resolves false when it could not be sent. */
  paint(deviceId: string, colors: RGB[]): Promise<boolean>;
  /** True when today's requests are close enough to Govee's limit that animations should wait. */
  overBudget(): boolean;
  /** Says something in the activity log. */
  note(text: string): void;
  changed(): void;
}

/** A light that fails this many steps in a row is dropped so it is not retried all night. */
const MAX_FAILURES = 3;

export class Animator {
  private failures = new Map<string, number>();
  private busy = false;
  private pausedOn: string | null = null;

  constructor(
    private store: Store,
    private host: AnimationHost,
  ) {}

  start(): void {
    setInterval(() => void this.tick(), 5_000).unref();
  }

  private get animations(): StoredAnimation[] {
    return this.store.data.animations;
  }

  has(deviceId: string): boolean {
    return this.animations.some((a) => a.lights.some((l) => l.id === deviceId));
  }

  /** Starts moving a look on lights that are already showing its first frame. */
  begin(look: StoredAnimation['look'], lights: StoredAnimation['lights'], now = Date.now()): void {
    this.release(lights.map((l) => l.id), false);
    const stepSeconds = motionStepSeconds(look, lights.map((l) => this.host.segments(l.id) ?? 0));
    this.animations.push({
      id: crypto.randomUUID(),
      look: { name: look.name, colors: look.colors, pattern: look.pattern, segments: look.segments, motion: look.motion },
      startedAt: now,
      stepSeconds,
      nextAt: now + stepSeconds * 1000,
      lights,
    });
    this.store.save();
    this.host.changed();
  }

  /** Takes lights out of whatever animation they are in. */
  release(deviceIds: string[], notify = true): void {
    const ids = new Set(deviceIds);
    let changed = false;
    for (const a of this.animations) {
      const kept = a.lights.filter((l) => !ids.has(l.id));
      if (kept.length !== a.lights.length) {
        a.lights = kept;
        changed = true;
      }
    }
    if (!changed) return;
    deviceIds.forEach((id) => this.failures.delete(id));
    this.store.data.animations = this.animations.filter((a) => a.lights.length > 0);
    this.store.save();
    if (notify) this.host.changed();
  }

  /** Sends the next frame of every animation that is due. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    const due = this.animations.filter((a) => now >= a.nextAt);
    if (due.length === 0) return;

    if (this.host.overBudget()) {
      const today = new Date(now).toDateString();
      if (this.pausedOn !== today) {
        this.pausedOn = today;
        this.host.note("Moving looks are paused for today to stay inside Govee's daily request limit");
      }
      return;
    }

    this.busy = true;
    try {
      for (const a of due) {
        // After a gap (the computer slept) this jumps to where the loop should be now.
        a.nextAt = now + a.stepSeconds * 1000;
        const phase = ((now - a.startedAt) / 60_000 / a.look.motion.loopMinutes) % 1;
        const gone: string[] = [];
        await Promise.all(
          a.lights.map(async (light) => {
            const segments = this.host.segments(light.id);
            if (segments === null) return void gone.push(light.id);
            const sent = await this.host.paint(light.id, renderLook(a.look, segments, light.index, phase));
            const count = sent ? 0 : (this.failures.get(light.id) ?? 0) + 1;
            this.failures.set(light.id, count);
            if (count >= MAX_FAILURES) {
              gone.push(light.id);
              this.host.note(`Stopped moving "${a.look.name || 'colours'}" on a light after repeated failures`);
            }
          }),
        );
        if (gone.length) this.release(gone);
      }
    } finally {
      this.busy = false;
      this.store.save();
    }
  }
}
