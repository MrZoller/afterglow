import { expect, test } from './fixtures';

test.use({ appEnv: { ACCESS_TOKEN: 'opensesame' } });

test('with a passphrase set, the page, the API and the MCP endpoint all ask for it', async ({ page, app }) => {
  await test.step('requests without it are refused', async () => {
    expect((await fetch(`${app.url}/api/snapshot`)).status).toBe(401);
    const control = await fetch(`${app.url}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: ['all'], action: { type: 'power', on: false } }) });
    expect(control.status).toBe(401);
    expect((await fetch(`${app.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    // Nothing was switched off by the refused request.
    expect((await app.snapshot()).devices.some((d) => d.state.power)).toBe(true);
  });

  await test.step('the page shows a lock screen and rejects a wrong passphrase', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Afterglow' })).toBeVisible();
    await page.getByLabel('Passphrase').fill('wrong');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('That passphrase is not right')).toBeVisible();
    await expect(page.locator('.light')).toHaveCount(0);
  });

  await test.step('the right passphrase opens the app, and stays unlocked on reload', async () => {
    await page.getByLabel('Passphrase').fill('opensesame');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.locator('.light').first()).toBeVisible();
    await page.reload();
    await expect(page.locator('.light').first()).toBeVisible();
    // The browser holds something derived from the passphrase, not the passphrase.
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.value.includes('opensesame'))).toBe(false);
  });

  await test.step('requests from another website are refused even with the passphrase', async () => {
    const res = await fetch(`${app.url}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer opensesame', Origin: 'https://elsewhere.example' },
      body: JSON.stringify({ targets: ['all'], action: { type: 'power', on: false } }),
    });
    expect(res.status).toBe(403);
  });
});
