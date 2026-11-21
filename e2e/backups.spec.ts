import fs from 'node:fs';
import { expect, goTo, test } from './fixtures';

test('backups can be made, restored, downloaded and restored from a file', async ({ page, app }, testInfo) => {
  await page.goto('/#/settings');
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Backups' }) });
  const counts = async () => {
    const s = await app.snapshot();
    return [s.looks.length, s.groups.length, s.schedules.length];
  };
  const [looks, zones, schedules] = await counts();
  const summary = `${looks} looks, ${zones} zones, ${schedules} schedules`;

  await test.step('a daily backup is made at startup', async () => {
    await expect(card.locator('.backup-row')).toHaveCount(1);
    await expect(card.locator('.backup-row').first()).toContainText(`Daily · ${summary}`);
  });

  await test.step('Back up now adds one', async () => {
    await card.getByRole('button', { name: 'Back up now' }).click();
    await expect(page.getByText('Backup saved')).toBeVisible();
    await expect(card.locator('.backup-row')).toHaveCount(2);
    await expect(card.locator('.backup-row').first()).toContainText('Made by hand');
  });

  const file = testInfo.outputPath('backup.json');
  await test.step('Download a backup saves the setup without secrets or passing state', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('link', { name: 'Download a backup' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^afterglow-backup-\d{4}-\d{2}-\d{2}\.json$/);
    await download.saveAs(file);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(doc.app).toBe('afterglow');
    expect(doc.looks).toHaveLength(looks);
    expect(doc.lights).toHaveLength(8);
    expect(Object.keys(doc)).not.toContain('devices');
    expect(Object.keys(doc)).not.toContain('activity');
  });

  await test.step('restoring brings back what was deleted, after saving what it replaces', async () => {
    const before = await app.snapshot();
    const sunset = before.looks.find((l) => l.name === 'Sunset')!;
    await app.api('DELETE', `/looks/${sunset.id}`);
    await app.api('DELETE', `/groups/${before.groups[0].id}`);
    expect(await counts()).toEqual([looks - 1, zones - 1, schedules]);

    const row = card.locator('.backup-row', { hasText: 'Made by hand' });
    await row.getByRole('button', { name: /^Restore the backup/ }).click();
    await row.getByRole('button', { name: 'Replace current setup' }).click();
    await expect(page.getByText(`Restored ${summary}`)).toBeVisible();
    expect(await counts()).toEqual([looks, zones, schedules]);
    expect((await app.snapshot()).looks.some((l) => l.id === sunset.id)).toBe(true);
    await expect(card).toContainText(`Before a restore · ${looks - 1} looks, ${zones - 1} zone${zones - 1 === 1 ? '' : 's'}, ${schedules} schedules`);

    // Other pages pick the change up without a reload.
    await goTo(page, 'Looks');
    await expect(page.locator('.look-card', { hasText: 'Sunset' }).first()).toBeVisible();
    await goTo(page, 'Settings');
  });

  await test.step('a downloaded file can be restored, after showing what it holds', async () => {
    await app.api('DELETE', `/schedules/${(await app.snapshot()).schedules[0].id}`);
    await card.locator('input[type=file]').setInputFiles(file);
    await expect(card.locator('.notice')).toContainText(`This file holds ${summary}, saved`);
    await card.locator('.notice').getByRole('button', { name: 'Restore this file' }).click();
    await expect.poll(counts).toEqual([looks, zones, schedules]);
  });

  await test.step('a file that is not a backup is refused and changes nothing', async () => {
    const bad = testInfo.outputPath('not-a-backup.json');
    fs.writeFileSync(bad, JSON.stringify({ hello: 'world' }));
    await card.locator('input[type=file]').setInputFiles(bad);
    await expect(page.getByText('That file is not an Afterglow backup')).toBeVisible();
    await expect(card.locator('.notice')).toHaveCount(0);
    expect(await counts()).toEqual([looks, zones, schedules]);
  });
});
