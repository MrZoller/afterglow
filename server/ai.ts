import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { fromHex, toHex } from '../shared/color';
import type { Look, LookIdea, LookPattern, RGB } from '../shared/types';
import { HttpError } from './hub';

/** Turns a description ("cosy autumn evening") into look designs, using Claude. */

const MODEL = 'claude-opus-5-5';
const MAX_COLORS = 8;

/** True when an Anthropic credential is configured; the feature is hidden otherwise. */
export const aiEnabled = () => !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());

// Deliberately loose: limits are applied in tidy() so one odd value does not sink the whole reply.
const Reply = z.object({
  ideas: z.array(
    z.object({
      name: z.string().describe('Short evocative name, one to three words'),
      colors: z.array(z.string()).describe('The palette: one to eight hex colours like "#ff8a1f"'),
      pattern: z.enum(['gradient', 'blocks', 'alternate', 'perLight', 'solid', 'custom']),
      segments: z.array(z.string()).nullable().describe('Only for the custom pattern: 6 to 20 hex colours in order along one light. Null otherwise.'),
      brightness: z.number().nullable().describe('1 to 100, or null to leave brightness as it is'),
      loop_minutes: z.number().nullable().describe('For a slowly moving look: minutes for one full loop through the palette, 10 to 240. Null for a still look.'),
      note: z.string().describe('One short sentence on how it will look'),
    }),
  ),
  scenes: z.array(z.string()).describe('Up to three names from the built-in animated scenes list that fit the request, best first. Empty when none fit or no list was given.'),
});

const SYSTEM = `You design lighting looks for outdoor LED lights (neon rope lights and garden lights) in a home lighting app. The person describes a mood, an occasion or an image, and you propose looks they can preview on their lights and save.

A look is a palette of one to eight colours plus a pattern that spreads it over the lights:
- gradient: the colours blend smoothly along each light
- blocks: each light is split into equal bands, one per colour
- alternate: the colours repeat segment by segment, like a candy stripe
- perLight: each light takes a single colour, cycling through the palette from light to light
- solid: every light shows the first colour
- custom: you paint the segments yourself by giving "segments", 6 to 20 colours in order along one light, which is stretched to fit each light. Use it only when no other pattern can express the idea, for example accents at the two ends.

What matters when choosing colours:
- These are LEDs, so colour is light, not pigment. Dark colours such as brown, navy, maroon or black come out dim and muddy. Use the bright, saturated version of the hue and lower "brightness" when the mood should be darker. Black means off.
- For white, use a tinted hex: #ffb46b is warm white, #fff1e0 soft white, #cfe3ff cool moonlight.
- Each distinct colour on a light is sent as a separate command, so a painted design should use eight distinct colours or fewer.
- Set "brightness" only when the mood calls for it (dim for cosy, bright for a party); otherwise null leaves the lights as they are.

A look can be still or slowly moving. With "loop_minutes" set, the palette slowly rotates through the pattern, one full loop in that many minutes (10 to 240): on solid the lights drift together from one colour to the next, on perLight the colours travel from light to light, and on the other patterns they flow along each light. The palette is a closed loop, so the last colour blends back into the first; choose colours that sit well next to each other in that order. This is gentle change over minutes. Use it when the person asks for colours that shift, drift or change slowly, and leave it null otherwise.

Fast motion (flicker, chase, twinkle) is not possible in a look. When the person asks for that, give looks that capture the palette, and put matching built-in animated scenes in "scenes". Only use scene names from the list in the message, copied exactly.

Give three ideas that differ meaningfully from one another in palette, pattern or mood. When the message includes the look being edited and the request reads as an adjustment to it, keep everything the person did not ask to change.`;

export interface SuggestInput {
  prompt: string;
  /** The design being edited, when the request may be a refinement of it. */
  current?: Pick<Look, 'name' | 'colors' | 'pattern' | 'brightness' | 'motion'> | null;
  lightCount: number;
  segmentCounts: number[];
  /** Built-in animated scenes the lights offer. */
  sceneNames: string[];
}

function userMessage(input: SuggestInput): string {
  const parts = [`Request: ${input.prompt}`];
  if (input.current) {
    const c = input.current;
    parts.push(
      `Look being edited: ${JSON.stringify({ name: c.name || undefined, colors: c.colors.map(toHex), pattern: c.pattern, brightness: c.brightness, loop_minutes: c.motion?.loopMinutes ?? null })}`,
    );
  }
  const segments = input.segmentCounts.length ? `, with ${input.segmentCounts.join(' and ')} segments each` : '';
  parts.push(`Setup: ${input.lightCount} light${input.lightCount === 1 ? '' : 's'}${segments}.`);
  parts.push(input.sceneNames.length ? `Built-in animated scenes: ${input.sceneNames.join(', ')}` : 'Built-in animated scenes: none available.');
  return parts.join('\n\n');
}

const hexes = (list: string[] | null | undefined): RGB[] => (list ?? []).map(fromHex).filter((c): c is RGB => c !== null);

/** Brings a model reply inside the limits the rest of the app relies on. */
export function tidy(reply: z.infer<typeof Reply>, sceneNames: string[]): { ideas: LookIdea[]; sceneNames: string[] } {
  const ideas: LookIdea[] = [];
  for (const idea of reply.ideas) {
    let pattern: LookPattern = idea.pattern;
    let colors = [...new Set(hexes(idea.colors))];
    let segments = pattern === 'custom' ? hexes(idea.segments).slice(0, 60) : [];
    const painted = [...new Set(segments)];

    if (pattern === 'custom') {
      if (segments.length < 2 || painted.length < 2) {
        // Nothing to paint: fall back to bands of the palette.
        pattern = 'blocks';
        segments = [];
      } else if (painted.length > MAX_COLORS) {
        // Too many colours to send in reasonable time: keep the palette, blended.
        pattern = 'gradient';
        colors = painted;
        segments = [];
      } else {
        // The palette of a painted design is exactly the colours painted, so the editor can recolour it.
        colors = painted;
      }
    }
    colors = colors.slice(0, MAX_COLORS);
    if (colors.length === 0) continue;

    const brightness = typeof idea.brightness === 'number' && Number.isFinite(idea.brightness) ? Math.max(1, Math.min(100, Math.round(idea.brightness))) : null;
    // Movement needs at least two colours to move between.
    const loop = typeof idea.loop_minutes === 'number' && Number.isFinite(idea.loop_minutes) && colors.length > 1 ? Math.max(5, Math.min(720, Math.round(idea.loop_minutes))) : null;
    ideas.push({
      name: idea.name.trim().slice(0, 60) || 'Untitled',
      colors,
      pattern,
      ...(pattern === 'custom' ? { segments } : {}),
      brightness,
      ...(loop ? { motion: { loopMinutes: loop } } : {}),
      note: idea.note.trim().slice(0, 200),
    });
  }

  const known = new Map(sceneNames.map((n) => [n.toLowerCase(), n]));
  const scenes = [...new Set(reply.scenes.map((s) => known.get(s.trim().toLowerCase())).filter((n): n is string => !!n))].slice(0, 3);
  return { ideas: ideas.slice(0, 4), sceneNames: scenes };
}

let client: Anthropic | null = null;

export async function suggestLooks(input: SuggestInput): Promise<{ ideas: LookIdea[]; sceneNames: string[] }> {
  if (!aiEnabled()) throw new HttpError(400, 'Add ANTHROPIC_API_KEY to the .env file and restart to use suggestions');
  client ??= new Anthropic({ maxRetries: 1, timeout: 90_000 });

  let response;
  try {
    response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // If a safety filter declines the request, Anthropic retries it on its recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // A small creative task: low effort keeps the wait short.
      output_config: { effort: 'low', format: betaZodOutputFormat(Reply) },
      system: SYSTEM,
      messages: [{ role: 'user', content: userMessage(input) }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'Anthropic rejected the API key');
    if (err instanceof Anthropic.PermissionDeniedError) throw new HttpError(502, 'This Anthropic key is not allowed to use the model');
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(502, 'Anthropic is rate limiting requests; try again in a moment');
    if (err instanceof Anthropic.APIConnectionError) throw new HttpError(502, 'Could not reach Anthropic');
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `Anthropic returned an error (${err.status ?? 'unknown'})`);
    // The reply did not match the expected shape.
    throw new HttpError(502, 'The suggestion could not be read; try again');
  }

  if (response.stop_reason === 'refusal') throw new HttpError(422, 'The assistant declined that request; try describing it differently');
  if (response.stop_reason === 'max_tokens' || !response.parsed_output) throw new HttpError(502, 'The suggestion came back incomplete; try again');

  const result = tidy(response.parsed_output, input.sceneNames);
  if (result.ideas.length === 0) throw new HttpError(502, 'No usable ideas came back; try again');
  return result;
}
