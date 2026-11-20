import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';

/**
 * These tests run the real request code against a stand-in for the Claude API, so they
 * check what is sent and how replies are handled, not what a model would actually say.
 */

interface Captured {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

let server: Server;
let captured: Captured[] = [];
let respond: (body: any) => { status: number; json: unknown };

const message = (text: string, extra: object = {}) => ({
  status: 200,
  json: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...extra,
  },
});

const goodReply = {
  ideas: [
    { name: 'Harvest', colors: ['#ff7a00', '#ffb000', '#c8ff3d'], pattern: 'gradient', segments: null, brightness: 60, note: 'Warm amber fading to gold.' },
    { name: 'Ends', colors: ['#ff0000', '#ffb46b'], pattern: 'custom', segments: ['#ff0000', '#ffb46b', '#ffb46b', '#ffb46b', '#ffb46b', '#ff0000'], brightness: null, note: 'Red tips on warm white.' },
    { name: 'Trio', colors: ['#ff0000', '#00ff00', '#0000ff'], pattern: 'perLight', segments: null, brightness: 250, note: 'One colour per light.' },
  ],
  scenes: ['sunset', 'Not A Scene', 'Candlelight'],
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.post('/v1/messages', (req, res) => {
    captured.push({ url: req.url, headers: req.headers, body: req.body });
    const { status, json } = respond(req.body);
    res.status(status).json(json);
  });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});
after(() => server.close());

const input = { prompt: 'cosy autumn evening', lightCount: 8, segmentCounts: [15, 12], sceneNames: ['Sunset', 'Candlelight', 'Aurora'] };

describe('look suggestions', () => {
  it('sends a structured-output request with the description and setup, and nothing personal', async () => {
    const { suggestLooks } = await import('../server/ai');
    captured = [];
    respond = () => message(JSON.stringify(goodReply));
    await suggestLooks({ ...input, current: { name: 'Mine', colors: [0xff0000, 0x0000ff], pattern: 'blocks', brightness: 40 } });

    assert.equal(captured.length, 1);
    const { headers, body } = captured[0];
    assert.equal(headers['authorization'], 'Bearer test-key');
    assert.match(String(headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.deepEqual(Object.keys(body.output_config.format.schema.properties).sort(), ['ideas', 'scenes']);
    // Parameters current models reject must not be sent.
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice']) assert.equal(body[key], undefined, key);

    const text: string = body.messages[0].content;
    assert.match(text, /Request: cosy autumn evening/);
    assert.match(text, /"colors":\["#ff0000","#0000ff"\]/);
    assert.match(text, /8 lights, with 15 and 12 segments each/);
    assert.match(text, /Built-in animated scenes: Sunset, Candlelight, Aurora/);
  });

  it('cleans up the reply: clamps brightness, keeps valid painted designs, and only returns known scenes', async () => {
    const { suggestLooks } = await import('../server/ai');
    respond = () => message(JSON.stringify(goodReply));
    const result = await suggestLooks(input);

    assert.deepEqual(
      result.ideas.map((i) => [i.name, i.pattern, i.brightness]),
      [
        ['Harvest', 'gradient', 60],
        ['Ends', 'custom', null],
        ['Trio', 'perLight', 100],
      ],
    );
    assert.deepEqual(result.ideas[0].colors, [0xff7a00, 0xffb000, 0xc8ff3d]);
    assert.equal(result.ideas[0].segments, undefined);
    assert.deepEqual(result.ideas[1].segments, [0xff0000, 0xffb46b, 0xffb46b, 0xffb46b, 0xffb46b, 0xff0000]);
    assert.deepEqual(result.sceneNames, ['Sunset', 'Candlelight']);
  });

  it('repairs designs that would not work on the lights', async () => {
    const { tidy } = await import('../server/ai');
    const many = Array.from({ length: 12 }, (_, i) => `#${(i * 20).toString(16).padStart(2, '0')}ff00`);
    const { ideas } = tidy(
      {
        ideas: [
          { name: ' No paint ', colors: ['#ff0000', 'nonsense', '#00ff00'], pattern: 'custom', segments: null, brightness: null, note: 'x' },
          { name: 'Too many', colors: [], pattern: 'custom', segments: many, brightness: 0, note: 'x' },
          { name: 'Empty', colors: ['red', 'blue'], pattern: 'solid', segments: null, brightness: null, note: 'x' },
          { name: '', colors: ['#ABC'], pattern: 'solid', segments: ['#ff0000'], brightness: null, note: 'x' },
        ],
        scenes: [],
      },
      [],
    );
    assert.deepEqual(ideas[0], { name: 'No paint', colors: [0xff0000, 0x00ff00], pattern: 'blocks', brightness: null, note: 'x' });
    assert.equal(ideas[1].pattern, 'gradient');
    assert.equal(ideas[1].colors.length, 8);
    assert.equal(ideas[1].brightness, 1);
    // An idea with no usable colours is dropped; shorthand hex and a missing name are tolerated.
    assert.equal(ideas.length, 3);
    assert.deepEqual(ideas[2], { name: 'Untitled', colors: [0xaabbcc], pattern: 'solid', brightness: null, note: 'x' });
  });

  it('turns API failures into plain messages', async () => {
    const { suggestLooks } = await import('../server/ai');
    respond = () => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    await assert.rejects(suggestLooks(input), /rejected the API key/);

    respond = () => message('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } });
    await assert.rejects(suggestLooks(input), /declined that request/);

    respond = () => message('{"ideas": [{"name": "cut off', { stop_reason: 'max_tokens' });
    await assert.rejects(suggestLooks(input), /could not be read|incomplete/);

    respond = () => message(JSON.stringify({ ideas: [], scenes: [] }));
    await assert.rejects(suggestLooks(input), /No usable ideas/);
  });

  it('is off without a key', async () => {
    const { aiEnabled, suggestLooks } = await import('../server/ai');
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.equal(aiEnabled(), false);
      await assert.rejects(suggestLooks(input), /ANTHROPIC_API_KEY/);
    } finally {
      process.env.ANTHROPIC_API_KEY = key;
    }
    assert.equal(aiEnabled(), true);
  });
});
