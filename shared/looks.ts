import { resample, sampleGradient } from './color';
import type { Look, LookPattern, RGB } from './types';

/**
 * Each distinct colour on a light costs one request to Govee, so gradients are drawn
 * in at most this many bands.
 */
export const MAX_BANDS = 8;

export const PATTERNS: { id: LookPattern; label: string; hint: string }[] = [
  { id: 'gradient', label: 'Gradient', hint: 'Colours blend along each light' },
  { id: 'blocks', label: 'Blocks', hint: 'Each light split into equal bands' },
  { id: 'alternate', label: 'Alternating', hint: 'Colours repeat segment by segment' },
  { id: 'perLight', label: 'One per light', hint: 'Each light takes the next colour' },
  { id: 'solid', label: 'Solid', hint: 'Every light in the first colour' },
  { id: 'custom', label: 'Painted', hint: 'Your own segment-by-segment design' },
];

/**
 * Colours for one light.
 * @param segments how many segments the light has (0 or 1 means a single colour)
 * @param index position of this light among the lights the look is applied to
 */
export function renderLook(look: Pick<Look, 'colors' | 'pattern' | 'segments'>, segments: number, index = 0): RGB[] {
  const palette = look.colors.length ? look.colors : [0xffffff];
  const n = Math.max(1, segments);
  const own = palette[index % palette.length];

  switch (look.pattern) {
    case 'solid':
      return Array(n).fill(palette[0]);
    case 'perLight':
      return Array(n).fill(own);
    case 'alternate':
      return n === 1 ? [own] : Array.from({ length: n }, (_, i) => palette[i % palette.length]);
    case 'blocks':
      return n === 1 ? [own] : resample(palette, n);
    case 'custom': {
      const painted = look.segments?.length ? look.segments : palette;
      return n === 1 ? [painted[Math.floor(painted.length / 2)]] : resample(painted, n);
    }
    case 'gradient':
    default: {
      if (n === 1) return [own];
      if (palette.length === 1) return Array(n).fill(palette[0]);
      const bands = Math.min(n, Math.max(palette.length, MAX_BANDS));
      const steps = Array.from({ length: bands }, (_, i) => sampleGradient(palette, bands === 1 ? 0 : i / (bands - 1)));
      return resample(steps, n);
    }
  }
}

/** Groups segment indexes by colour: one entry per request that has to be sent. */
export function groupByColor(colors: RGB[]): { rgb: RGB; segments: number[] }[] {
  const map = new Map<RGB, number[]>();
  colors.forEach((c, i) => {
    const list = map.get(c);
    if (list) list.push(i);
    else map.set(c, [i]);
  });
  return [...map.entries()].map(([rgb, segments]) => ({ rgb, segments }));
}

const now = 0;
const starter = (id: string, name: string, pattern: LookPattern, colors: RGB[], brightness: number | null = null): Look => ({
  id,
  name,
  colors,
  pattern,
  brightness,
  createdAt: now,
  updatedAt: now,
});

/** Looks added on first run so the library is not empty. They can be edited or deleted. */
export const STARTER_LOOKS: Look[] = [
  starter('starter-warm', 'Warm welcome', 'solid', [0xffb46b], 70),
  starter('starter-sunset', 'Sunset', 'gradient', [0xff3d2e, 0xff8a1f, 0xffc94d, 0xb14bff]),
  starter('starter-ocean', 'Ocean', 'gradient', [0x0047ff, 0x00b3ff, 0x19ffd6]),
  starter('starter-forest', 'Forest', 'gradient', [0x0b7a2a, 0x4dff5c, 0xc8ff3d]),
  starter('starter-ember', 'Campfire', 'alternate', [0xff2a00, 0xff7a00, 0xffb000], 60),
  starter('starter-aurora', 'Aurora', 'gradient', [0x19ff8c, 0x00c2ff, 0x8a4dff, 0xff4dd2]),
  starter('starter-holiday', 'Holiday', 'alternate', [0xff1a1a, 0x12d84a, 0xfff2d6]),
  starter('starter-spooky', 'Spooky', 'blocks', [0xff6a00, 0x7a1fff, 0x39ff14]),
  starter('starter-liberty', 'Red, white & blue', 'perLight', [0xff1a2e, 0xffffff, 0x1a4dff]),
  starter('starter-moon', 'Moonlight', 'solid', [0xcfe3ff], 35),
];
