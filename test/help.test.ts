import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HELP, type Block } from '../web/src/help';

const TABS = ['lights', 'looks', 'schedules', 'settings', 'help'];
const texts = (blocks: Block[]) => blocks.flatMap((b) => (typeof b === 'string' ? [b] : 'list' in b ? b.list : b.steps));

describe('help content', () => {
  const entries = HELP.flatMap((topic) => topic.entries);

  it('has an answer for every question, and no question twice', () => {
    assert.ok(entries.length > 20);
    for (const entry of entries) assert.ok(texts(entry.answer).join('').trim().length > 40, entry.question);
    assert.equal(new Set(entries.map((e) => e.question)).size, entries.length);
  });

  it('only links to parts of the app that exist', () => {
    const links = entries.flatMap((e) => texts(e.answer)).flatMap((t) => [...t.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]));
    assert.ok(links.length > 5);
    for (const link of links) assert.ok(TABS.some((tab) => link === `#/${tab}`), `unknown link ${link}`);
  });

  it('closes every inline mark it opens', () => {
    for (const text of entries.flatMap((e) => [e.question, ...texts(e.answer)])) {
      assert.equal((text.match(/\*\*/g) ?? []).length % 2, 0, text);
      assert.equal((text.match(/`/g) ?? []).length % 2, 0, text);
    }
  });
});
