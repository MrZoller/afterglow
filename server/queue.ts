import { RateLimitError } from './govee/cloud';

interface Task {
  slot: string;
  /** Sent over the local network: no pacing needed, since Govee's limits only apply to the cloud. */
  local: boolean;
  run: () => Promise<void>;
  resolve: (outcome: 'sent' | 'superseded') => void;
  reject: (err: Error) => void;
  attempts: number;
}

interface Lane {
  tasks: Task[];
  busy: boolean;
  tokens: number;
  refilledAt: number;
  pausedUntil: number;
}

export interface QueueOptions {
  /** Commands a light accepts back to back. */
  burst: number;
  /** Sustained commands per second per light after the burst. */
  perSecond: number;
  maxAttempts: number;
  onChange?: (deviceId: string) => void;
}

/** Wait used when Govee reports a rate limit without saying how long to wait. */
const BACKOFF_MS = [2_000, 8_000, 30_000, 60_000];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sends each light's commands in order and paces them to stay inside Govee's limits.
 * A newer command for the same "slot" (power, brightness, appearance) replaces older
 * ones still waiting, so dragging a slider does not build up a backlog.
 */
export class CommandQueue {
  private lanes = new Map<string, Lane>();

  constructor(private opts: QueueOptions) {}

  private lane(deviceId: string): Lane {
    let lane = this.lanes.get(deviceId);
    if (!lane) {
      lane = { tasks: [], busy: false, tokens: this.opts.burst, refilledAt: Date.now(), pausedUntil: 0 };
      this.lanes.set(deviceId, lane);
    }
    return lane;
  }

  pending(deviceId: string): number {
    const lane = this.lanes.get(deviceId);
    return lane ? lane.tasks.length + (lane.busy ? 1 : 0) : 0;
  }

  /** Drops commands that have not been sent yet for the given slots. */
  cancel(deviceId: string, slots: string[]): void {
    const lane = this.lanes.get(deviceId);
    if (!lane) return;
    const keep: Task[] = [];
    for (const task of lane.tasks) {
      if (slots.includes(task.slot)) task.resolve('superseded');
      else keep.push(task);
    }
    lane.tasks = keep;
  }

  push(deviceId: string, slot: string, run: () => Promise<void>, local = false): Promise<'sent' | 'superseded'> {
    const lane = this.lane(deviceId);
    const done = new Promise<'sent' | 'superseded'>((resolve, reject) => {
      lane.tasks.push({ slot, local, run, resolve, reject, attempts: 0 });
    });
    this.opts.onChange?.(deviceId);
    void this.pump(deviceId, lane);
    return done;
  }

  private async pump(deviceId: string, lane: Lane): Promise<void> {
    if (lane.busy) return;
    lane.busy = true;
    try {
      while (lane.tasks.length) {
        // Order within a light is always kept; only cloud commands wait for the rate limit.
        const local = lane.tasks[0].local;
        if (!local) {
          const now = Date.now();
          if (lane.pausedUntil > now) {
            await sleep(lane.pausedUntil - now);
            continue; // the head of the queue may have changed while waiting
          }

          const elapsed = (Date.now() - lane.refilledAt) / 1000;
          lane.tokens = Math.min(this.opts.burst, lane.tokens + elapsed * this.opts.perSecond);
          lane.refilledAt = Date.now();
          if (lane.tokens < 1) {
            await sleep(((1 - lane.tokens) / this.opts.perSecond) * 1000);
            continue;
          }
        }

        // The task may have been cancelled while we were waiting.
        const task = lane.tasks.shift();
        if (!task) break;
        if (!task.local) lane.tokens -= 1;
        try {
          await task.run();
          task.resolve('sent');
        } catch (err) {
          task.attempts += 1;
          if (err instanceof RateLimitError && task.attempts < this.opts.maxAttempts) {
            const wait = err.retryAfterMs ?? BACKOFF_MS[Math.min(task.attempts - 1, BACKOFF_MS.length - 1)];
            lane.pausedUntil = Date.now() + wait;
            lane.tasks.unshift(task);
          } else {
            task.reject(err as Error);
          }
        }
        this.opts.onChange?.(deviceId);
      }
    } finally {
      lane.busy = false;
      this.opts.onChange?.(deviceId);
    }
  }
}
