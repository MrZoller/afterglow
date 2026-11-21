import { renderLook } from '../shared/looks';
import type { Look, RGB } from '../shared/types';
import type { Store } from './store';

/**
 * Runs moving looks: every so often it works out how far round its loop each one is and
 * sends the lights their next colours. A light leaves its animation as soon as anything
 * else is applied to it.
 *
 * Each light steps at its own pace. One reached over the local network can take a tiny
 * step every few seconds; one driven through Govee's cloud steps less often to stay
 * inside its request allowance. Because the colours come from the clock, lights
 * stepping at different rates still stay together.
 */

export interface StoredAnimation {
  id: string;
  /** A copy of the look as it was when applied, so later edits do not change it mid-run. */
  look: Pick<Look, 'colors' | 'pattern' | 'segments'> & { motion: NonNullable<Look['motion']>; name: string };
  startedAt: number;
  /** `index` is the light's position among the lights the look was applied to. */
  lights: { id: string; index: number; nextAt: number }[];
}

export interface FramePlan {
  segments: number;
  /** True when this light's frames go over the local network and cost no cloud requests. */
  local: boolean;
  stepSeconds: number;
}

export interface AnimationHost {
  /** How to drive this light for this look right now, or null when the light no longer exists. */
  plan(look: StoredAnimation['look'], deviceId: string, index: number): FramePlan | null;
  /** Shows a frame on a light; resolves false when it could not be sent. */
  paint(deviceId: string, colors: RGB[]): Promise<boolean>;
  /** True when today's cloud requests are close enough to Govee's limit that animations should wait. */
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
  ) {
    // Animations saved by an earlier version kept one timer for all their lights.
    for (const a of this.animations) for (const light of a.lights) light.nextAt ??= Date.now();
  }

  start(): void {
    setInterval(() => void this.tick(), 2_000).unref();
  }

  private get animations(): StoredAnimation[] {
    return this.store.data.animations;
  }

  has(deviceId: string): boolean {
    return this.animations.some((a) => a.lights.some((l) => l.id === deviceId));
  }

  /** Starts moving a look on lights that are already showing its first frame. */
  begin(look: StoredAnimation['look'], lights: { id: string; index: number }[], now = Date.now()): void {
    this.release(lights.map((l) => l.id), false);
    const stored: StoredAnimation['look'] = { name: look.name, colors: look.colors, pattern: look.pattern, segments: look.segments, motion: look.motion };
    this.animations.push({
      id: crypto.randomUUID(),
      look: stored,
      startedAt: now,
      lights: lights.map((l) => ({ ...l, nextAt: now + (this.host.plan(stored, l.id, l.index)?.stepSeconds ?? 60) * 1000 })),
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

  /** Sends the next frame to every light that is due one. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const gone: string[] = [];
      const work: Promise<void>[] = [];
      for (const a of [...this.animations]) {
        const phase = ((now - a.startedAt) / 60_000 / a.look.motion.loopMinutes) % 1;
        for (const light of a.lights) {
          if (now < light.nextAt) continue;
          const plan = this.host.plan(a.look, light.id, light.index);
          if (!plan) {
            gone.push(light.id);
            continue;
          }
          // After a gap (the computer slept) this jumps to where the loop should be now.
          light.nextAt = now + plan.stepSeconds * 1000;

          // The daily limit only concerns the cloud; lights driven locally keep moving.
          if (!plan.local && this.host.overBudget()) {
            const today = new Date(now).toDateString();
            if (this.pausedOn !== today) {
              this.pausedOn = today;
              this.host.note("Moving looks sent through Govee's cloud are paused for today to stay inside its daily request limit");
            }
            continue;
          }

          work.push(
            this.host.paint(light.id, renderLook(a.look, plan.segments, light.index, phase)).then((sent) => {
              const count = sent ? 0 : (this.failures.get(light.id) ?? 0) + 1;
              this.failures.set(light.id, count);
              if (count >= MAX_FAILURES) {
                gone.push(light.id);
                this.host.note(`Stopped moving "${a.look.name || 'colours'}" on a light after repeated failures`);
              }
            }),
          );
        }
      }
      if (work.length === 0 && gone.length === 0) return;
      await Promise.all(work);
      if (gone.length) this.release(gone);
      this.store.save();
    } finally {
      this.busy = false;
    }
  }
}
