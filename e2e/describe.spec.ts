import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, goTo, test as base } from './fixtures';

/**
 * "Describe a look" against a stand-in for the Claude API that always answers with the
 * same three ideas. This checks what the app sends and what it does with a reply, not
 * what a real model would suggest.
 */

const REPLY = {
  ideas: [
    { name: 'Harvest glow', colors: ['#ff7a00', '#ffb000', '#ffd98a'], pattern: 'gradient', segments: null, brightness: 55, loop_minutes: 45, note: 'Amber melting into soft gold, dimmed for a cosy feel.' },
    { name: 'Ember tips', colors: ['#ff3d00', '#ffb46b'], pattern: 'custom', segments: ['#ff3d00', '#ff3d00', '#ffb46b', '#ffb46b', '#ffb46b', '#ffb46b', '#ff3d00', '#ff3d00'], brightness: null, loop_minutes: null, note: 'Warm white with glowing red-orange ends.' },
    { name: 'Orchard', colors: ['#ff5a1f', '#c8ff3d', '#ffb000'], pattern: 'perLight', segments: null, brightness: 70, loop_minutes: null, note: 'Each light takes one autumn colour.' },
  ],
  scenes: ['Sunset', 'Candlelight', 'Made up'],
};

interface Stub {
  url: string;
  /** The user message of every request received. */
  messages: string[];
}

const test = base.extend<{ claude: Stub }>({
  claude: async ({}, use) => {
    const messages: string[] = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        const body = JSON.parse(data || '{}');
        messages.push(body.messages?.[0]?.content ?? '');
        const message = { id: 'msg_stub', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(REPLY) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        // A short delay, so the "working on it" state is on screen long enough to check.
        setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message)), 400);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await use({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, messages });
    await new Promise((resolve) => server.close(resolve));
  },
  appEnv: async ({ claude }, use) => {
    await use({ ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: claude.url });
  },
});

test('a description returns ideas that load into the editor and can be saved', async ({ page, app, claude }) => {
  await page.goto('/');
  await goTo(page, 'Looks');
  const prompt = page.getByLabel('Describe the look you want');

  await test.step('Describe opens the editor with the box ready to type in', async () => {
    await page.getByRole('button', { name: 'Describe a look' }).click();
    await expect(prompt).toBeFocused();
    await expect(page.getByRole('button', { name: 'Suggest' })).toBeDisabled();
  });

  await test.step('a description brings back three ideas and the scenes that exist', async () => {
    await prompt.fill('cosy autumn evening');
    await prompt.press('Enter');
    await expect(page.getByText('Coming up with ideas')).toBeVisible();
    await expect(page.locator('.assist .option')).toHaveCount(3);
    await expect(page.locator('.assist-scenes .chip')).toHaveText(['Sunset', 'Candlelight']);

    expect(claude.messages[0]).toContain('Request: cosy autumn evening');
    expect(claude.messages[0]).not.toContain('Look being edited');
    // Nothing that identifies the home leaves it.
    expect(claude.messages[0]).not.toMatch(/rope|path|yard|Denver/i);
  });

  await test.step('picking an idea loads its name, colours and pattern', async () => {
    const idea = page.locator('.assist .option', { hasText: 'Ember tips' });
    await idea.click();
    await expect(page.getByPlaceholder('e.g. Game night')).toHaveValue('Ember tips');
    await expect(idea).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.palette .swatch.xl:not(.add)')).toHaveCount(2);
    await expect(page.locator('.options .option[aria-pressed="true"]', { hasText: 'Painted' })).toHaveCount(1);
  });

  await test.step('a follow-up is sent as a change to the look being edited', async () => {
    await prompt.fill('warmer');
    await page.getByRole('button', { name: 'Again' }).click();
    await expect.poll(() => claude.messages.length).toBe(2);
    expect(claude.messages[1]).toContain('Request: warmer');
    expect(claude.messages[1]).toContain('Look being edited: {"name":"Ember tips","colors":["#ff3d00","#ffb46b"],"pattern":"custom","brightness":null,"loop_minutes":null}');
    await expect(page.locator('.assist .option')).toHaveCount(3);
  });

  await test.step('a suggested scene plays on the lights', async () => {
    await page.locator('.assist-scenes .chip', { hasText: 'Candlelight' }).click();
    await expect
      .poll(async () => (await app.snapshot()).devices.filter((d) => d.sku === 'H61A9').every((d) => d.state.appearance.mode === 'scene' && d.state.appearance.scene.name === 'Candlelight'))
      .toBe(true);
  });

  await test.step('an idea can be tried and saved, movement included', async () => {
    await page.locator('.assist .option', { hasText: 'Harvest glow' }).click();
    await page.getByRole('button', { name: 'Try', exact: true }).click();
    await expect.poll(async () => (await app.snapshot()).devices[0].state.brightness).toBe(55);
    await page.getByRole('button', { name: 'Save look' }).click();
    await expect(page.locator('.look-card', { hasText: 'Harvest glow' })).toBeVisible();
    const look = (await app.snapshot()).looks.find((l) => l.name === 'Harvest glow')!;
    expect([look.pattern, look.brightness, look.colors.length, look.motion]).toEqual(['gradient', 55, 3, { loopMinutes: 45 }]);
  });
});

base('without an Anthropic key the editor explains how to turn suggestions on', async ({ page }) => {
  await page.goto('/#/looks');
  await expect(page.getByRole('button', { name: 'Describe a look' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New look' }).click();
  await expect(page.locator('.assist-off')).toContainText('ANTHROPIC_API_KEY');
});
