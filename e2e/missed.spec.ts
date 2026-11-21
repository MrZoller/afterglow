import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, goTo, test as base } from './fixtures';

/**
 * Missed schedules: catching up, the record of lights dropping off the network, and
 * phone notifications. Notifications go to a stand-in for the notification service that
 * records what arrives, so these check what the app sends and when, not that a real
 * phone shows it.
 */

interface Receiver {
  url: string;
  /** Every notification received, oldest first. */
  got: { title: string; priority: string; text: string }[];
  /** Makes the next notifications fail with this status. */
  failWith(status: number | null): void;
}

const test = base.extend<{ phone: Receiver }>({
  phone: async ({}, use) => {
    const got: Receiver['got'] = [];
    let failing: number | null = null;
    const server = http.createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        if (failing) return void res.writeHead(failing).end('{}');
        got.push({ title: String(req.headers.title), priority: String(req.headers.priority), text });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await use({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/afterglow-test-topic`, got, failWith: (status) => void (failing = status) });
    await new Promise((resolve) => server.close(resolve));
  },
});

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

test.describe('without notifications set up', () => {
  test('Settings explains how, and the catch-up switch is saved', async ({ page, app }) => {
    await page.goto('/');
    await goTo(page, 'Settings');
    const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Missed schedules' }) });
    const catchUp = card.getByRole('switch', { name: 'Catch up after a missed schedule' });

    await test.step('notifications say they are not set up, and Help lists it', async () => {
      await expect(card).toContainText('Not set up');
      await expect(card.getByRole('button', { name: 'Send a test' })).toHaveCount(0);
      expect((await app.snapshot()).status.notify).toEqual({ enabled: false, lastAt: null, error: null });
      await card.getByRole('link', { name: 'Help' }).click();
      await expect(page.locator('.help-todo')).toContainText('Phone notifications are not set up');
      const steps = page.locator('details', { hasText: 'How do I get told on my phone when something goes wrong?' });
      await steps.locator('summary').click();
      await expect(steps.locator('.help-answer')).toContainText('NOTIFY_URL=https://ntfy.sh/');
    });

    await test.step('catching up is on to begin with, and switching it off is remembered', async () => {
      await goTo(page, 'Settings');
      await expect(catchUp).toHaveAttribute('aria-checked', 'true');
      await expect(card).toContainText('carried out as soon as it can be');
      await catchUp.click();
      await expect(catchUp).toHaveAttribute('aria-checked', 'false');
      await expect(card).toContainText('A schedule that was missed is skipped');
      await expect.poll(async () => (await app.snapshot()).settings.catchUp).toBe(false);
      await page.reload();
      await expect(catchUp).toHaveAttribute('aria-checked', 'false');
    });
  });

  test('a light that drops off the network is recorded under Lights', async ({ page, app }) => {
    await app.simulate('Side yard lights', { offline: true });
    await app.api('POST', '/rescan');
    await page.goto('/#/settings');
    const row = page.locator('.device-row', { has: page.getByLabel('Name for Side yard lights') });

    await test.step('while it is gone, its row says since when', async () => {
      await expect(row.locator('.dropouts')).toHaveText(/^Unreachable since today at /);
      await expect(page.locator('.device-row .dropouts')).toHaveCount(1);
      const light = await app.light('Side yard lights');
      expect(light.state.online).toBe(false);
      expect(light.dropouts.week).toBe(1);
      expect(light.dropouts.last?.to).toBeNull();
    });

    await test.step('once it is back, the row says how often and for how long', async () => {
      await app.simulate('Side yard lights', { offline: false });
      await app.api('POST', '/rescan');
      await expect(row.locator('.dropouts')).toHaveText(/^Dropped off the network once in the last 7 days · last today at .+ for 1 minute$/);
      expect((await app.light('Side yard lights')).dropouts.last?.to).not.toBeNull();
      // One or two lines on a phone, not a block.
      expect((await row.locator('.dropouts').boundingBox())!.height).toBeLessThanOrEqual(50);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    });
  });
});

const notifying = test.extend({
  appEnv: async ({ phone }, use) => {
    await use({ NOTIFY_URL: phone.url });
  },
});

notifying('a test notification can be sent from Settings', async ({ page, app, phone }) => {
  await page.goto('/#/settings');
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Missed schedules' }) });
  await expect(card.locator('.badge')).toHaveText('On');

  await notifying.step('pressing the button sends one, and the card says when', async () => {
    await card.getByRole('button', { name: 'Send a test' }).click();
    await expect(page.locator('.toast')).toContainText('Sent');
    expect(phone.got).toEqual([{ title: 'Afterglow test', priority: 'default', text: expect.stringContaining('Notifications are working') }]);
    await expect(card).toContainText(/Last sent today at /);
    expect((await app.snapshot()).status.notify.lastAt).not.toBeNull();
  });

  await notifying.step('one that does not get through is reported with the reason', async () => {
    phone.failWith(403);
    await card.getByRole('button', { name: 'Send a test' }).click();
    await expect(page.locator('.toast.error')).toContainText('did not get through');
    await expect(card.locator('.error-text')).toContainText('answered 403');
    expect((await app.snapshot()).status.notify.error).toContain('answered 403');
    expect(phone.got).toHaveLength(1);
  });

  await notifying.step('Help no longer lists notifications as still to set up', async () => {
    await goTo(page, 'Help');
    await expect(page.locator('.help-todo')).not.toContainText('Phone notifications');
  });
});

notifying('a schedule missed while the app was stopped runs when it starts again', async ({ page, app, phone }) => {
  // Only the schedule under test, so nothing else has a later say over the lights.
  for (const s of (await app.snapshot()).schedules) await app.api('DELETE', `/schedules/${s.id}`);
  await app.api('POST', '/control', { targets: ['all'], action: { type: 'power', on: false } });
  await expect.poll(async () => (await app.snapshot()).devices.every((d) => d.state.power === false && d.pending === 0)).toBe(true);
  const now = Date.now();
  await app.api('POST', '/schedules', {
    name: 'Evening',
    days: EVERY_DAY,
    start: { type: 'clock', time: hhmm(new Date(now - 3 * 3600_000)) },
    end: { type: 'clock', time: hhmm(new Date(now + 2 * 3600_000)) },
    targets: ['all'],
    action: { type: 'look', lookId: 'starter-warm' },
  });

  // As if the schedule had been saved long ago and the computer was off at its start time.
  await app.restart((data) => {
    for (const s of data.schedules) s.lastStart = s.lastEnd = 0;
  });

  await notifying.step('the lights come on with the look they should have had', async () => {
    await expect.poll(async () => (await app.snapshot()).devices.every((d) => d.state.power === true && d.state.lookId === 'starter-warm')).toBe(true);
  });

  await notifying.step('Recent activity and a notification say it ran late', async () => {
    await page.goto('/#/settings');
    await expect(page.locator('.activity')).toContainText('“Evening” started 3 hours late');
    await expect.poll(() => phone.got.map((n) => n.title)).toEqual(['Schedule ran late']);
    expect(phone.got[0].text).toMatch(/when “Evening” should have started\. It started at /);
  });

  await notifying.step('it does not run a second time', async () => {
    const entries = (await app.snapshot()).activity.filter((a) => /late/.test(a.text));
    expect(entries).toHaveLength(1);
  });
});

const hurried = notifying.extend({
  // The follow-up checks normally come 1, 3, 10, 30 and 60 minutes after a schedule; here seconds apart.
  appEnv: async ({ phone }, use) => {
    await use({ NOTIFY_URL: phone.url, AFTERGLOW_CHECK_SCALE: '0.02' });
  },
});

// Waits on real time: the schedule's start at the next minute, then the checks after it.
hurried('a light off the network when a schedule starts is brought in when it returns @slow', async ({ page, app, phone }) => {
  hurried.setTimeout(5 * 60_000);
  for (const s of (await app.snapshot()).schedules) await app.api('DELETE', `/schedules/${s.id}`);
  await app.api('POST', '/control', { targets: ['all'], action: { type: 'power', on: false } });
  const lights = (await app.snapshot()).devices.filter((d) => ['Back garden lights', 'Side yard lights'].includes(d.name));
  await app.simulate('Side yard lights', { offline: true });

  const now = new Date();
  const start = new Date(now.getTime() + (now.getSeconds() > 40 ? 120_000 : 60_000));
  start.setSeconds(0, 0);
  const schedule = await app.api<{ id: string }>('POST', '/schedules', {
    name: 'Flags',
    days: EVERY_DAY,
    start: { type: 'clock', time: hhmm(start) },
    targets: lights.map((d) => d.id),
    action: { type: 'look', lookId: 'starter-liberty' },
  });
  const view = async () => (await app.snapshot()).schedules.find((s) => s.id === schedule.id)!;

  await page.goto('/#/schedules');
  const card = page.locator('.schedule', { hasText: 'Flags' });

  await hurried.step('the light that was reachable starts; the card names the one still being tried', async () => {
    await expect.poll(async () => (await app.light('Back garden lights')).state.power, { timeout: 3 * 60_000, intervals: [2_000] }).toBe(true);
    await expect.poll(async () => (await view()).catchingUp).toEqual({ kind: 'start', lights: ['Side yard lights'] });
    await expect(card.locator('.trying')).toHaveText('Still trying to start Side yard lights');
    expect((await app.colors('Back garden lights'))[0]).toBe(0xff1a2e);
  });

  await hurried.step('after several tries a notification says which light missed it', async () => {
    await expect.poll(() => phone.got.map((n) => n.title), { timeout: 60_000 }).toEqual(['Lights missed a schedule']);
    expect(phone.got[0].priority).toBe('high');
    expect(phone.got[0].text).toMatch(/^“Flags” started at .+, but Side yard lights could not be reached\. Afterglow will keep trying\.$/);
  });

  await hurried.step('back on the network, it is given its own share of the look', async () => {
    await app.simulate('Side yard lights', { offline: false });
    await expect.poll(async () => (await app.light('Side yard lights')).state.power, { timeout: 90_000, intervals: [1_000] }).toBe(true);
    // The second light of a "one per light" look is white; on its own it would have been red.
    await expect.poll(async () => (await app.colors('Side yard lights'))[0]).toBe(0xffffff);
    await expect(card.locator('.trying')).toHaveCount(0);
  });

  await hurried.step('and a second notification says it has caught up', async () => {
    await expect.poll(() => phone.got.map((n) => n.title), { timeout: 120_000, intervals: [2_000] }).toEqual(['Lights missed a schedule', 'Lights caught up']);
    expect(phone.got[1].text).toMatch(/^Side yard lights has caught up with “Flags”/);
    expect((await view()).catchingUp).toBeNull();
  });
});
