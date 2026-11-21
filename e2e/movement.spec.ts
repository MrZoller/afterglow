import { expect, goTo, test } from './fixtures';

test('moving looks are labelled and their previews play', async ({ page }) => {
  await page.goto('/#/looks');
  const moving = page.locator('.look-card', { hasText: 'Drifting aurora' });
  await expect(moving.locator('.sub')).toHaveText(/One per light · moves, 30 min loop/);

  const paint = (card: typeof moving) => card.locator('.strip').first().evaluate((el) => (el as HTMLElement).style.getPropertyValue('--paint'));
  const before = await paint(moving);
  await expect.poll(() => paint(moving)).not.toBe(before);

  // A still look's preview stays put.
  const still = page.locator('.look-card', { hasText: 'Ocean' });
  const stillBefore = await paint(still);
  await page.waitForTimeout(600);
  expect(await paint(still)).toBe(stillBefore);
});

test('movement can be turned on, applied, seen stepping and held', async ({ page, app }) => {
  await page.goto('/');
  await goTo(page, 'Looks');

  await test.step('the editor turns movement on and says what it will do', async () => {
    await page.getByRole('button', { name: 'New look' }).click();
    await page.getByPlaceholder('e.g. Game night').fill('Slow tide');
    await page.locator('.option', { hasText: 'Solid' }).click();
    await page.getByRole('switch', { name: 'Slowly move the colours' }).click();
    await page.getByLabel('Time for one full loop').selectOption('10');
    // In the demo the four ropes answer locally and the four garden lights do not.
    await expect(page.locator('.field', { hasText: 'Movement' }).locator('.field-hint')).toHaveText(
      /The lights change colour together\. On all lights, 4 lights take a tiny step about every 5 seconds over your own network, using no Govee requests; the other 4 take a step about every 50 seconds through Govee's cloud, roughly 288 requests an hour\./,
    );
    await page.getByRole('button', { name: 'Save look' }).click();
    await expect.poll(async () => (await app.snapshot()).looks.find((l) => l.name === 'Slow tide')?.motion).toEqual({ loopMinutes: 10 });
  });

  await test.step('applying it starts the lights moving', async () => {
    await page.locator('.look-card', { hasText: 'Slow tide' }).getByRole('button', { name: 'Apply' }).click();
    await page.locator('.row-btn', { hasText: 'Front yard' }).click();
    await expect.poll(async () => (await app.snapshot()).devices.filter((d) => d.moving).length).toBe(4);
    await goTo(page, 'Lights');
    await expect(page.locator('.light', { hasText: 'Front fence rope' }).locator('.sub')).toHaveText(/Slow tide · moving/);
  });

  await test.step('a light reached locally takes its next small step within seconds, using no requests', async () => {
    const [first] = await app.colors('Front fence rope');
    const requests = (await app.snapshot()).status.requestsToday;
    await expect.poll(async () => (await app.colors('Front fence rope'))[0], { timeout: 20_000 }).not.toBe(first);
    expect((await app.light('Front fence rope')).moving).toBe(true);
    // Only the two garden lights in the zone could have used any, and their step is not due yet.
    expect((await app.snapshot()).status.requestsToday - requests).toBeLessThanOrEqual(2);
  });

  await test.step('Hold here stops the movement and keeps the colours', async () => {
    await page.getByRole('button', { name: 'Front yard', exact: true }).click();
    await page.getByRole('button', { name: 'Hold here' }).click();
    await expect.poll(async () => (await app.snapshot()).devices.some((d) => d.moving)).toBe(false);
    const held = await app.colors('Front fence rope');
    await page.waitForTimeout(6_000);
    expect(await app.colors('Front fence rope')).toEqual(held);
    await expect(page.getByRole('button', { name: 'Hold here' })).toHaveCount(0);
  });
});

// A light driven through the cloud steps about once a minute, so this waits that long.
test('a moving look steps through the cloud for one request per light @slow', async ({ app }) => {
  test.setTimeout(3 * 60_000);
  const look = await app.api<{ id: string }>('POST', '/looks', { name: 'Slow', colors: [0xff0000, 0x00ff00, 0x0000ff], pattern: 'solid', brightness: null, motion: { loopMinutes: 10 } });
  const garden = (await app.snapshot()).devices.filter((d) => !d.local).slice(0, 2);
  await app.api('POST', '/control', { targets: garden.map((d) => d.id), action: { type: 'look', lookId: look.id } });
  await expect.poll(async () => (await app.snapshot()).devices.filter((d) => d.moving).length).toBe(2);
  await expect.poll(async () => (await app.light(garden[0].name)).pending).toBe(0);

  const [first] = await app.colors(garden[0].name);
  const requests = (await app.snapshot()).status.requestsToday;
  await expect.poll(async () => (await app.colors(garden[0].name))[0], { timeout: 90_000, intervals: [3_000] }).not.toBe(first);
  await expect.poll(async () => (await app.snapshot()).status.requestsToday - requests).toBe(2);
});
