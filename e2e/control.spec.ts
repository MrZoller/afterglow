import { drag, expect, goTo, test } from './fixtures';

test('lights can be switched and dimmed from their cards', async ({ page, app }) => {
  await page.goto('/');

  await test.step('a card switch turns its light off', async () => {
    expect((await app.light('Front fence rope')).state.power).toBe(true);
    const toggle = page.getByRole('switch', { name: 'Front fence rope power' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await app.light('Front fence rope')).state.power).toBe(false);
  });

  await test.step('dragging the brightness bar sets brightness on release', async () => {
    await drag(page, page.getByRole('slider', { name: 'Patio rope brightness' }), [0.8, 0.5], [0.25, 0.5]);
    await expect.poll(async () => (await app.light('Patio rope')).state.brightness).toBeGreaterThanOrEqual(23);
    expect((await app.light('Patio rope')).state.brightness).toBeLessThanOrEqual(28);
  });

  await test.step('All off switches everything off and offers All on', async () => {
    await page.getByRole('button', { name: 'All off' }).click();
    await expect.poll(async () => (await app.snapshot()).devices.every((d) => d.state.power === false)).toBe(true);
    await expect(page.getByRole('button', { name: 'All on' })).toBeVisible();
  });

  await test.step('what was done is in the activity log', async () => {
    const log = (await app.snapshot()).activity.map((a) => a.text);
    expect(log[0]).toBe('All lights: turned off');
    expect(log.some((line) => /^Patio rope: brightness 2\d%$/.test(line))).toBe(true);
  });
});

test('a light’s controls set colour, white and scenes', async ({ page, app }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Patio rope', exact: true }).click();
  await expect(page.locator('.sheet.side')).toBeVisible();

  await test.step('dragging on the colour pad picks a colour', async () => {
    await page.getByRole('tab', { name: 'Colour' }).click();
    // A third of the way across at the top is pure green.
    await drag(page, '.colorpad', [0.2, 0.05], [120 / 360, 0.01], 6);
    await expect.poll(async () => (await app.light('Patio rope')).state.appearance.mode).toBe('color');
    const [color] = await app.colors('Patio rope');
    expect((color >> 8) & 255).toBeGreaterThan(240);
    expect((color >> 16) & 255).toBeLessThan(40);
    expect(color & 255).toBeLessThan(40);
  });

  await test.step('a Govee scene can be chosen and is marked as playing', async () => {
    await page.getByRole('tab', { name: 'Scenes' }).click();
    const scene = page.locator('.scene', { hasText: 'Firefly' });
    await scene.click();
    await expect.poll(async () => (await app.light('Patio rope')).state.appearance).toEqual({ mode: 'scene', scene: { kind: 'light', name: 'Firefly' } });
    await expect(scene).toHaveAttribute('aria-pressed', 'true');
  });

  await test.step('a white preset sets the temperature', async () => {
    await page.getByRole('tab', { name: 'White' }).click();
    await page.getByRole('button', { name: 'Daylight' }).click();
    await expect.poll(async () => (await app.light('Patio rope')).state.appearance).toEqual({ mode: 'temp', kelvin: 6500 });
  });
});

test('segments can be painted, applied and saved as a look', async ({ page, app }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Patio rope', exact: true }).click();
  await page.getByRole('tab', { name: 'Paint' }).click();
  await page.getByRole('button', { name: 'Brush #1a4dff' }).click();
  // Drag across the first third of the strip.
  await drag(page, '.paint-strip', [0.01, 0.3], [0.33, 0.3], 12);
  await page.getByRole('button', { name: 'Apply to lights' }).click();

  await expect.poll(async () => (await app.colors('Patio rope')).slice(0, 5)).toEqual(Array(5).fill(0x1a4dff));
  const colors = await app.colors('Patio rope');
  expect(colors).toHaveLength(15);
  expect(colors[14]).not.toBe(0x1a4dff);

  await page.getByRole('button', { name: 'Save as look' }).click();
  await page.getByLabel('Look name').fill('Blue tip');
  await page.getByLabel('Look name').press('Enter');
  await expect.poll(async () => (await app.snapshot()).looks.find((l) => l.name === 'Blue tip')?.pattern).toBe('custom');
  expect((await app.snapshot()).looks.find((l) => l.name === 'Blue tip')!.segments).toHaveLength(15);
});

test('zones can be created and lights renamed in Settings', async ({ page, app }) => {
  await page.goto('/');
  await goTo(page, 'Settings');

  await page.getByRole('button', { name: 'New zone' }).click();
  await page.getByPlaceholder('e.g. Front yard').fill('Ropes');
  for (const name of ['Front fence rope', 'Patio rope']) await page.locator('.sheet .chip', { hasText: name }).click();
  await page.getByRole('button', { name: 'Save zone' }).click();
  await expect.poll(async () => (await app.snapshot()).groups.find((g) => g.name === 'Ropes')?.deviceIds.length).toBe(2);

  const name = page.getByLabel('Name for Side yard lights');
  await name.fill('Side gate');
  await name.press('Enter');
  await expect.poll(async () => (await app.snapshot()).devices.some((d) => d.name === 'Side gate')).toBe(true);
  expect((await app.light('Side gate')).goveeName).toBe('Side yard lights');
});

// The simulated Govee account also returns three groups made in the Govee app, as a real one can.
test('groups made in the Govee app are left out of the lights and named in Settings', async ({ page, app }) => {
  const snap = await app.snapshot();
  expect(snap.devices).toHaveLength(8);
  expect(snap.devices.map((d) => d.sku).sort()).toEqual(['H61A9', 'H61A9', 'H61A9', 'H61A9', 'H7086', 'H7086', 'H7086', 'H7086']);
  expect(snap.status.goveeGroups).toEqual(['All ropes', 'Front scene', 'Whole yard']);

  await page.goto('/#/settings');
  await expect(page.locator('.device-row')).toHaveCount(8);
  await expect(page.locator('.govee-groups')).toHaveText('Not listed: 3 groups made in the Govee app (All ropes, Front scene, Whole yard). Each of their lights is already here and controlled directly. To switch lights together, make a zone.');
  await page.goto('/#/lights');
  await expect(page.getByText('All ropes')).toHaveCount(0);
  await expect(page.locator('.card', { hasText: 'All lights' }).first()).toContainText('of 8 on');
});
