import { expect, goTo, test } from './fixtures';

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

test('a schedule can be created, paused and run on demand', async ({ page, app }) => {
  await page.goto('/');
  await goTo(page, 'Schedules');

  await test.step('the editor saves what was chosen', async () => {
    await page.getByRole('button', { name: 'New schedule' }).click();
    await page.getByPlaceholder('e.g. Evening glow').fill('Weekend party');
    await page.getByRole('button', { name: 'Front yard' }).click();
    await page.getByRole('button', { name: 'Govee scene' }).click();
    await page.getByLabel('Scene', { exact: true }).selectOption({ label: 'Rainbow' });
    await page.getByLabel('Start offset').selectOption('-30');
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) await page.getByRole('button', { name: day }).click();
    await page.getByRole('button', { name: 'Save schedule' }).click();
    await expect(page.locator('.schedule', { hasText: 'Weekend party' })).toBeVisible();

    const saved = (await app.snapshot()).schedules.find((s) => s.name === 'Weekend party')!;
    expect(saved.days).toEqual([0, 6]);
    expect(saved.start).toEqual({ type: 'sun', event: 'sunset', offsetMin: -30 });
    expect(saved.end).toEqual({ type: 'clock', time: '23:00' });
    expect(saved.action).toEqual({ type: 'scene', scene: { kind: 'light', name: 'Rainbow' } });
    expect(saved.targets).toHaveLength(1);
    expect(saved.targets[0]).toMatch(/^group:/);
    expect(saved.next).not.toBeNull();
  });

  await test.step('its switch pauses it', async () => {
    await page.getByRole('switch', { name: 'Weekend party enabled' }).click();
    await expect.poll(async () => (await app.snapshot()).schedules.find((s) => s.name === 'Weekend party')!.enabled).toBe(false);
    expect((await app.snapshot()).schedules.find((s) => s.name === 'Weekend party')!.next).toBeNull();
  });

  await test.step('the play button runs it straight away', async () => {
    await page.getByRole('button', { name: 'Run Weekend party now' }).click();
    await expect.poll(async () => (await app.light('Front path lights')).state.appearance).toEqual({ mode: 'scene', scene: { kind: 'light', name: 'Rainbow' } });
  });
});

// Waits on real time: the schedule's end, then the first check a minute after it.
test('a scheduled turn-off is checked and confirmed @slow', async ({ page, app }) => {
  test.setTimeout(6 * 60_000);
  await app.api('POST', '/control', { targets: ['all'], action: { type: 'power', on: true } });
  const now = new Date();
  const end = new Date(now.getTime() + (now.getSeconds() > 40 ? 120_000 : 60_000));
  end.setSeconds(0, 0);
  const schedule = await app.api<{ id: string }>('POST', '/schedules', {
    name: 'Night test',
    days: [0, 1, 2, 3, 4, 5, 6],
    start: { type: 'clock', time: hhmm(new Date(now.getTime() - 600_000)) },
    end: { type: 'clock', time: hhmm(end) },
    targets: ['all'],
    action: { type: 'power', on: true },
  });
  const view = async () => (await app.snapshot()).schedules.find((s) => s.id === schedule.id)!;

  await page.goto('/#/schedules');
  const card = page.locator('.schedule', { hasText: 'Night test' });

  await test.step('when the schedule ends the lights go off and a check begins', async () => {
    await expect.poll(async () => (await view()).checkingOff, { timeout: 3 * 60_000, intervals: [2_000] }).toBe(true);
    await expect.poll(async () => (await app.snapshot()).devices.every((d) => d.state.power === false)).toBe(true);
    await expect(card).toContainText('Checking that the lights turned off');
  });

  await test.step('about a minute later the card says the turn-off was confirmed', async () => {
    await expect.poll(async () => (await view()).lastOff?.ok, { timeout: 2.5 * 60_000, intervals: [3_000] }).toBe(true);
    expect((await view()).lastOff!.text).toBe('Confirmed off');
    await expect(card).toContainText(/Turn-off today at .*: confirmed off/);
    expect((await app.snapshot()).activity.map((a) => a.text)).toContain('“Night test” ended: lights confirmed off');
  });
});
