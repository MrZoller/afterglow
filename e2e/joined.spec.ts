import { drag, expect, goTo, test } from './fixtures';

const GREEN = 0x00ff00;
const RED = 0xff0000;

test('two ropes can be joined, checked with the test pattern, and used as one light', async ({ page, app }) => {
  await page.goto('/');

  await test.step('a zone of two lights can be marked as joined and put in order', async () => {
    await page.getByRole('button', { name: 'New zone' }).click();
    await page.getByPlaceholder('e.g. Front yard').fill('Right walkway');
    await expect(page.getByRole('switch', { name: 'These lights are joined end to end' })).toHaveCount(0);
    await page.locator('.sheet .chip', { hasText: 'Patio rope' }).click();
    await page.locator('.sheet .chip', { hasText: 'Front fence rope' }).click();
    await page.getByRole('switch', { name: 'These lights are joined end to end' }).click();
    await expect(page.locator('.order-name')).toHaveText(['Patio rope', 'Front fence rope']);
    await page.getByRole('button', { name: 'Move Front fence rope up' }).click();
    await expect(page.locator('.order-name')).toHaveText(['Front fence rope', 'Patio rope']);
  });

  await test.step('Save and test lights the run green at its start and red at its end', async () => {
    await page.getByRole('button', { name: 'Save and test' }).click();
    await expect(page.getByText('The run should now start green')).toBeVisible();
    await expect.poll(async () => (await app.colors('Patio rope'))[14], { timeout: 20_000 }).toBe(RED);
    expect((await app.colors('Front fence rope'))[0]).toBe(GREEN);
    expect((await app.colors('Front fence rope'))[14]).not.toBe(RED);
    expect((await app.snapshot()).groups.find((g) => g.name === 'Right walkway')!.joined).toBe(true);
  });

  await test.step('ticking Reversed flips that rope on the next test', async () => {
    const row = page.locator('.order-row.boxed', { hasText: 'Patio rope' });
    await row.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Save and test' }).click();
    await expect.poll(async () => (await app.colors('Patio rope'))[0], { timeout: 20_000 }).toBe(RED);
    expect((await app.light('Patio rope')).reversed).toBe(true);

    await row.getByRole('checkbox').uncheck();
    await page.getByRole('button', { name: 'Save zone' }).click();
    await expect.poll(async () => (await app.light('Patio rope')).reversed).toBe(false);
    expect((await app.snapshot()).groups.filter((g) => g.name === 'Right walkway')).toHaveLength(1);
  });

  await test.step('the zone’s card says the lights are joined', async () => {
    await expect(page.locator('.light', { hasText: 'Right walkway' }).locator('.sub')).toHaveText(/2 lights joined · on/);
  });

  await test.step('a look applied to the zone spreads across both ropes', async () => {
    await page.getByRole('button', { name: 'Right walkway', exact: true }).click();
    await page.locator('.tile', { hasText: 'Ocean' }).click();
    await expect.poll(async () => (await app.colors('Patio rope'))[14], { timeout: 20_000 }).toBe(0x19ffd6);
    const first = await app.colors('Front fence rope');
    const second = await app.colors('Patio rope');
    expect(first[0]).toBe(0x0047ff);
    // Eight bands over the pair is four each.
    expect(new Set(first).size).toBeLessThanOrEqual(4);
    expect(new Set(second).size).toBeLessThanOrEqual(4);
  });

  await test.step('painting covers the whole run, and a stroke can cross the join', async () => {
    await page.getByRole('tab', { name: 'Paint' }).click();
    await expect(page.locator('.paint-strip i')).toHaveCount(30);
    await expect(page.locator('.panel')).toContainText('These lights are joined');
    await page.getByRole('button', { name: 'Brush #ff3d2e' }).click();
    await page.getByRole('button', { name: 'Fill all' }).click();
    await page.getByRole('button', { name: 'Brush #1a4dff' }).click();
    await drag(page, '.paint-strip', [0.4, 0.3], [0.6, 0.3], 14);
    await page.getByRole('button', { name: 'Apply to lights' }).click();
    await expect.poll(async () => (await app.colors('Patio rope'))[0], { timeout: 20_000 }).toBe(0x1a4dff);
    const first = await app.colors('Front fence rope');
    const second = await app.colors('Patio rope');
    expect([first[0], first[14], second[14]]).toEqual([0xff3d2e, 0x1a4dff, 0xff3d2e]);
  });
});

test('lights can be reordered and reversed in Settings', async ({ page, app }) => {
  await page.goto('/');
  await goTo(page, 'Settings');
  const before = (await app.snapshot()).devices.map((d) => d.name);
  await page.getByRole('button', { name: `Move ${before[1]} up` }).click();
  await expect.poll(async () => (await app.snapshot()).devices.map((d) => d.name).slice(0, 2)).toEqual([before[1], before[0]]);

  const box = page.locator('.device-row', { has: page.getByLabel('Name for Deck rail rope') }).getByRole('checkbox');
  await box.check();
  await expect(box).toBeChecked();
  await expect.poll(async () => (await app.light('Deck rail rope')).reversed).toBe(true);
});
