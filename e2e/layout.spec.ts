import type { Page } from '@playwright/test';
import { expect, test, type App } from './fixtures';

/**
 * Checks that only show up once screens have content in them. Two styling bugs have come
 * from a label or preview sharing a class name with a layout rule and growing to the
 * height of the screen; an empty list hides that completely.
 */

/** Fills the app with the kinds of content that have caught layout bugs before. */
async function fill(app: App): Promise<void> {
  const snap = await app.snapshot();
  const backYard = snap.groups.find((g) => g.name === 'Back yard')!;
  await app.api('POST', `/schedules/${snap.schedules[0].id}/run`);
  await app.api('POST', '/control', { targets: ['all'], action: { type: 'look', lookId: 'starter-sunset' } });
  await app.api('POST', '/control', { targets: ['all'], action: { type: 'brightness', value: 60 } });
  // One entry from an assistant, through the MCP endpoint.
  await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'control_lights', arguments: { targets: ['front yard'], color: '#00ff88' } } }),
  });
  // Last, so nothing after it replaces the scene: these lights should be drawn shimmering.
  await app.api('POST', '/control', { targets: [`group:${backYard.id}`], action: { type: 'scene', scene: { kind: 'light', name: 'Aurora' } } });
}

const heights = (page: Page, selector: string) => page.locator(selector).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const [device, viewport] of [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 860 }],
] as const) {
  test.describe(`layout on a ${device}`, () => {
    test.use({ viewport });

    test('labels, previews and pages keep their size once there is content', async ({ page, app }) => {
      await fill(app);
      await page.goto('/');

      await test.step('light previews stay strip-sized, including ones playing a scene', async () => {
        await expect(page.locator('.strip.shimmer').first()).toBeVisible();
        for (const height of await heights(page, '.strip')) expect(height).toBeLessThanOrEqual(20);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      });

      await test.step('activity entries are one or two lines, with label-sized source labels', async () => {
        await page.locator('.nav').getByRole('button', { name: 'Settings' }).click();
        await expect(page.locator('.activity li').first()).toBeVisible();
        expect(await page.locator('.activity .badge').allInnerTexts()).toEqual(expect.arrayContaining(['You', 'Agent']));
        for (const height of await heights(page, '.badge')) expect(height).toBeLessThanOrEqual(30);
        for (const height of await heights(page, '.activity li')) expect(height).toBeLessThanOrEqual(70);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
      });

      await test.step('no section scrolls sideways', async () => {
        for (const section of ['Looks', 'Schedules', 'Help', 'Lights']) {
          await page.locator('.nav').getByRole('button', { name: section, exact: true }).click();
          await expect(page.getByRole('heading', { level: 1, name: section })).toBeVisible();
          expect(await overflow(page), `${section} is wider than the screen`).toBeLessThanOrEqual(0);
        }
      });

      await test.step('a light’s controls fit the screen', async () => {
        await page.getByRole('button', { name: 'Front yard', exact: true }).click();
        const sheet = page.locator('.sheet.side');
        await expect(sheet).toBeVisible();
        // The sheet slides in, so wait for it to come to rest before measuring.
        await expect
          .poll(async () => {
            const box = (await sheet.boundingBox())!;
            return box.x >= 0 && box.x + box.width <= viewport.width;
          })
          .toBe(true);
        for (const tab of ['Scenes', 'Colour', 'White', 'Paint', 'Looks']) {
          await page.getByRole('tab', { name: tab, exact: true }).click();
          expect(await overflow(page), `${tab} tab is wider than the screen`).toBeLessThanOrEqual(0);
        }
      });
    });
  });
}
