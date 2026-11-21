import { expect, goTo, test } from './fixtures';

/**
 * Multi-colour designs sent straight to the lights. In the demo the four ropes answer on
 * a simulated local network that understands the message; the garden lights are reached
 * through the simulated cloud only. This checks the app's side: what is sent which way.
 * Whether a real model acts on the message can only be seen on the light.
 */

const GREEN = 0x00ff00;
const BLUE = 0x0000ff;
const RED = 0xff0000;
const THIRDS = [...Array<number>(5).fill(GREEN), ...Array<number>(5).fill(BLUE), ...Array<number>(5).fill(RED)];
const ROPES = ['Front fence rope', 'Patio rope', 'Deck rail rope', 'Driveway rope'];

test('local designs are tried on a model, switched on, and then use no cloud requests', async ({ page, app }) => {
  const requests = async () => (await app.snapshot()).status.requestsToday;
  const settled = (name: string) => expect.poll(async () => (await app.light(name)).pending).toBe(0);

  await page.goto('/#/settings');
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Designs over your own network' }) });
  const ropes = card.locator('.model-row', { hasText: 'H61A9' });
  const gardens = card.locator('.model-row', { hasText: 'H7086' });
  const toggle = ropes.getByRole('switch', { name: 'Send designs for H61A9 over your network' });

  await test.step('each model with segments is listed, off, with how many of its lights answer locally', async () => {
    await expect(card.locator('.badge')).toHaveText('Experimental');
    await expect(card.locator('.model-row')).toHaveCount(2);
    await expect(ropes).toContainText('Neon rope · H61A9');
    await expect(ropes).toContainText('4 of 4 answer on your network');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(gardens).toContainText('None answer on your network yet');
    await expect(gardens.getByRole('button', { name: 'Test H7086' })).toBeDisabled();
    expect((await app.snapshot()).devices.some((d) => d.localDesigns)).toBe(false);
  });

  await test.step('Test paints green, blue and red on every rope without the cloud, and switches nothing on', async () => {
    const before = await requests();
    const garden = await app.colors('Front path lights');
    await ropes.getByRole('button', { name: 'Test H61A9' }).click();
    await expect(page.locator('.toast')).toContainText('Sent to 4 lights');
    for (const name of ROPES) {
      expect(await app.colors(name), name).toEqual(THIRDS);
      expect((await app.light(name)).state.power, name).toBe(true);
    }
    expect(await requests()).toBe(before);
    expect(await app.colors('Front path lights')).toEqual(garden);
    expect((await app.snapshot()).settings.localDesigns ?? []).toEqual([]);
    expect((await app.snapshot()).activity[0].text).toBe('Test pattern sent over your network to 4 of 4 H61A9 lights');
  });

  await test.step('switching the model on is saved and shows on the lights that take it', async () => {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await app.snapshot()).settings.localDesigns).toEqual(['H61A9']);
    const devices = (await app.snapshot()).devices;
    expect(devices.filter((d) => d.localDesigns).map((d) => d.name)).toEqual(ROPES);
    await expect(page.locator('.device-row', { has: page.getByLabel('Name for Patio rope') })).toContainText('reached locally, designs too');
    await expect(page.locator('.device-row', { has: page.getByLabel('Name for Front path lights') })).toContainText('reached through the cloud');
    await expect(page.locator('.settings .card').first()).toContainText('Multi-colour designs go straight to them too');
  });

  await test.step('a look on a rope then costs nothing, while the same look on a garden light still does', async () => {
    const rope = await app.light('Patio rope');
    const garden = await app.light('Front path lights');
    const before = await requests();
    await app.api('POST', '/control', { targets: [rope.id], action: { type: 'look', lookId: 'starter-ocean' } });
    await settled('Patio rope');
    expect(new Set(await app.colors('Patio rope')).size).toBeGreaterThan(2);
    expect(await app.colors('Patio rope')).not.toEqual(THIRDS);
    expect(await requests()).toBe(before);

    await app.api('POST', '/control', { targets: [garden.id], action: { type: 'look', lookId: 'starter-ocean' } });
    await settled('Front path lights');
    expect((await requests()) - before).toBeGreaterThanOrEqual(3);
  });

  await test.step('the look editor says a moving gradient now takes small local steps on the ropes', async () => {
    await goTo(page, 'Looks');
    await page.getByRole('button', { name: 'New look' }).click();
    await page.getByPlaceholder('e.g. Game night').fill('Tide');
    await page.locator('.option', { hasText: 'Gradient' }).click();
    await page.getByRole('switch', { name: 'Slowly move the colours' }).click();
    await page.getByLabel('Time for one full loop').selectOption('10');
    await expect(page.locator('.field', { hasText: 'Movement' }).locator('.field-hint')).toHaveText(
      /Colours flow along each light\. On all lights, 4 lights take a tiny step about every 5 seconds over your own network, using no Govee requests; the other 4 take a step about every \d+ (seconds|minutes) through Govee's cloud/,
    );
    await page.getByRole('button', { name: 'Save look' }).click();
    await expect.poll(async () => (await app.snapshot()).looks.some((l) => l.name === 'Tide')).toBe(true);
  });

  await test.step('applied to a rope, its colours move on within seconds and still cost nothing', async () => {
    const rope = await app.light('Patio rope');
    const look = (await app.snapshot()).looks.find((l) => l.name === 'Tide')!;
    await app.api('POST', '/control', { targets: [rope.id], action: { type: 'look', lookId: look.id } });
    await settled('Patio rope');
    const before = await requests();
    const first = await app.colors('Patio rope');
    expect(new Set(first).size).toBeGreaterThan(1);
    await expect.poll(async () => app.colors('Patio rope'), { timeout: 20_000 }).not.toEqual(first);
    expect((await app.light('Patio rope')).moving).toBe(true);
    expect(await requests()).toBe(before);
  });

  await test.step('the switch is still on after a reload', async () => {
    await page.goto('/#/settings');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect.poll(async () => (await app.snapshot()).settings.localDesigns).toEqual([]);
    await expect(page.locator('.device-row', { has: page.getByLabel('Name for Patio rope') })).not.toContainText('designs too');
  });
});
