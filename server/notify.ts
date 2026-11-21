/**
 * Phone notifications, sent by posting to an address the owner chooses in `.env`.
 *
 * The format is the one ntfy uses (https://ntfy.sh, or a self-hosted copy): the message
 * is the request body and the title, priority and tags travel as headers. Anything else
 * that accepts a plain POST can receive them too.
 *
 * A notification is most needed when something is wrong, which is also when the internet
 * may be down, so one that cannot be delivered is tried again for a while.
 */

export interface Notice {
  /** Kept to plain ASCII: it travels as an HTTP header. */
  title: string;
  text: string;
  /** A problem that wants attention, rather than news that one has cleared. */
  urgent?: boolean;
}

export interface NotifierOptions {
  url: string;
  /** Sent as a bearer token, for a protected topic. */
  token?: string;
  /** An address that opens the app, attached so that tapping the notification goes there. */
  link?: () => string | undefined;
  /** Called when a notification is given up on. */
  onFailure?: (reason: string) => void;
  onChange?: () => void;
  /** Waits before each further attempt. */
  retryMs?: number[];
  timeoutMs?: number;
}

const RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

const asUrl = (text: string): URL | null => {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

export class Notifier {
  /** When a notification last got through. */
  lastAt: number | null = null;
  /** Why notifications are not working, if they are not. */
  error: string | null = null;

  private target: URL | null;

  constructor(private opts: NotifierOptions) {
    this.target = opts.url ? asUrl(opts.url) : null;
    if (opts.url && !this.target) this.error = 'NOTIFY_URL in the .env file is not a web address';
  }

  /** True when an address has been set, so there is somewhere to send to. */
  get enabled(): boolean {
    return !!this.target;
  }

  /** Sends one notification now. Rejects with a readable reason when it does not get through. */
  async deliver(notice: Notice): Promise<void> {
    if (!this.target) throw new Error(this.error ?? 'Notifications are not set up');
    const link = this.opts.link?.();
    let res: Response;
    try {
      res = await fetch(this.target, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Title: notice.title,
          Priority: notice.urgent ? 'high' : 'default',
          Tags: notice.urgent ? 'warning' : 'bulb',
          ...(link ? { Click: link } : {}),
          ...(this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {}),
        },
        body: notice.text,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      const reason = (err as Error).name === 'TimeoutError' ? 'no answer' : 'could not connect';
      throw new Error(`${this.target.host}: ${reason}`);
    }
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' (check NOTIFY_TOKEN, or that the topic allows publishing)' : '';
      throw new Error(`${this.target.host} answered ${res.status}${hint}`);
    }
  }

  /** Sends in the background, trying again later if it does not get through. Never throws. */
  send(notice: Notice): void {
    if (!this.target) return;
    void this.attempt(notice, 0);
  }

  /** As send(), resolving once the notification has gone or been given up on. */
  private async attempt(notice: Notice, tries: number): Promise<void> {
    try {
      await this.deliver(notice);
      this.lastAt = Date.now();
      this.error = null;
      this.opts.onChange?.();
    } catch (err) {
      this.error = (err as Error).message;
      this.opts.onChange?.();
      const wait = (this.opts.retryMs ?? RETRY_MS)[tries];
      if (wait === undefined) {
        this.opts.onFailure?.(this.error);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, wait).unref());
      await this.attempt(notice, tries + 1);
    }
  }

  /** The outcome of the test button: sends once, and records how it went. */
  async test(): Promise<void> {
    try {
      await this.deliver({ title: 'Afterglow test', text: 'Notifications are working. This is where Afterglow will tell you about a light that missed a schedule.' });
      this.lastAt = Date.now();
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      throw err;
    } finally {
      this.opts.onChange?.();
    }
  }
}
