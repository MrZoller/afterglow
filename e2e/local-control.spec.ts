import { expect, test } from './fixtures';

// In the demo the four rope lights also answer on a simulated local network.
test('Settings says which lights are reached locally and how to add the rest', async ({ page }) => {
  await page.goto('/#/settings');
  const connection = page.locator('.settings .card').first();
  await expect(connection).toContainText('4 of 8 lights answer on your own network');
  await expect(connection).toContainText('turn on LAN Control');
  await expect(page.locator('.device-row', { has: page.getByLabel('Name for Patio rope') })).toContainText('reached locally');
  await expect(page.locator('.device-row', { has: page.getByLabel('Name for Front path lights') })).toContainText('reached through the cloud');
});

test('switching a local light uses no cloud requests, and a cloud light uses one', async ({ page, app }) => {
  await page.goto('/');
  const requests = async () => (await app.snapshot()).status.requestsToday;
  const before = await requests();

  const rope = page.getByRole('switch', { name: 'Patio rope power' });
  await rope.click();
  await expect.poll(async () => (await app.light('Patio rope')).state.power).toBe(false);
  await expect.poll(async () => (await app.light('Patio rope')).pending).toBe(0);
  await rope.click();
  await expect.poll(async () => (await app.light('Patio rope')).state.power).toBe(true);
  await expect.poll(async () => (await app.light('Patio rope')).pending).toBe(0);
  expect(await requests()).toBe(before);

  await page.getByRole('switch', { name: 'Front path lights power' }).click();
  await expect.poll(requests).toBe(before + 1);
});
