import { expect, goTo, test } from './fixtures';

test('a saved look can be shown from a light’s controls', async ({ page, app }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Patio rope', exact: true }).click();
  const tile = page.locator('.tile', { hasText: 'Ocean' });
  await tile.click();
  await expect.poll(async () => (await app.light('Patio rope')).state.lookId).toBe('starter-ocean');
  expect((await app.light('Patio rope')).state.appearance.mode).toBe('segments');
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
});

test('a look can be created, tried, saved and applied to a zone', async ({ page, app }) => {
  await page.goto('/');
  await goTo(page, 'Looks');
  await page.getByRole('button', { name: 'New look' }).click();
  await page.getByPlaceholder('e.g. Game night').fill('Citrus');
  await page.locator('.option', { hasText: 'Blocks' }).click();

  await test.step('Try shows it on the lights without saving', async () => {
    await page.getByRole('button', { name: 'Try', exact: true }).click();
    await expect.poll(async () => (await app.light('Driveway rope')).state.appearance.mode).toBe('segments');
    expect((await app.light('Driveway rope')).state.lookId).toBeNull();
    expect((await app.snapshot()).looks.some((l) => l.name === 'Citrus')).toBe(false);
  });

  await test.step('Save adds it to the library', async () => {
    await page.getByRole('button', { name: 'Save look' }).click();
    await expect(page.locator('.look-card', { hasText: 'Citrus' })).toBeVisible();
    const look = (await app.snapshot()).looks.find((l) => l.name === 'Citrus')!;
    expect([look.pattern, look.colors.length]).toEqual(['blocks', 3]);
  });

  await test.step('Apply offers zones and applies to every light in the one chosen', async () => {
    await page.locator('.look-card', { hasText: 'Citrus' }).getByRole('button', { name: 'Apply' }).click();
    await page.locator('.row-btn', { hasText: 'Back yard' }).click();
    const snap = await app.snapshot();
    const citrus = snap.looks.find((l) => l.name === 'Citrus')!.id;
    const backYard = snap.groups.find((g) => g.name === 'Back yard')!.deviceIds;
    await expect.poll(async () => (await app.snapshot()).devices.filter((d) => backYard.includes(d.id)).every((d) => d.state.lookId === citrus)).toBe(true);
  });
});
