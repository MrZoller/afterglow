import { expect, test } from './fixtures';

for (const [device, viewport] of [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 860 }],
] as const) {
  test.describe(`Help on a ${device}`, () => {
    test.use({ viewport });

    test('is in the navigation, searchable, and links into the app', async ({ page }) => {
      await page.goto('/');

      await test.step('Help is the last of five sections and every label fits', async () => {
        await expect(page.locator('.nav button')).toHaveText(['Lights', 'Looks', 'Schedules', 'Settings', 'Help']);
        const cutOff = await page.locator('.nav button span').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
        expect(cutOff).toBe(0);
        await page.locator('.nav').getByRole('button', { name: 'Help' }).click();
        await expect(page).toHaveURL(/#\/help$/);
      });

      await test.step('it opens with what this install still needs, then the topics', async () => {
        await expect(page.locator('.help-todo')).toContainText('simulated lights');
        await expect(page.locator('.help-topic')).toHaveCount(8);
      });

      await test.step('tapping a question shows its answer', async () => {
        const item = page.locator('details', { hasText: 'How do I know the lights really turned off?' });
        await expect(item.locator('.help-answer')).toBeHidden();
        await item.locator('summary').click();
        await expect(item.locator('.help-answer')).toContainText('1, 3, 10, 30 and 60 minutes');
      });

      await test.step('search narrows to matching answers and opens them', async () => {
        const search = page.getByLabel('Search help');
        await search.fill('reversed backwards');
        const matches = await page.locator('details').count();
        expect(matches).toBeGreaterThanOrEqual(1);
        expect(matches).toBeLessThanOrEqual(4);
        await expect(page.locator('details[open]')).toHaveCount(matches);
        await expect(page.locator('.help-todo')).toHaveCount(0);

        await search.fill('zzzz');
        await expect(page.locator('.help')).toContainText('Nothing in the help matches');
        await search.fill('');
        await expect(page.locator('.help-topic')).toHaveCount(8);
      });

      await test.step('a link in an answer goes to that part of the app', async () => {
        const item = page.locator('details', { hasText: 'Sunrise and sunset do not work.' });
        await item.locator('summary').click();
        await item.getByRole('link', { name: 'Settings' }).click();
        await expect(page).toHaveURL(/#\/settings$/);
        await expect(page.locator('.settings')).toBeVisible();
      });
    });
  });
}
