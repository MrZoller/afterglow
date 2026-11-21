import { resample, sampleGradient, sampleLoop } from './color';
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

/** A moving gradient uses fewer bands than a still one, because every band is re-sent at each step. */
export const MOTION_BANDS = 5;

/** Choices for how long one full trip through the palette takes, in minutes. */
export const MOTION_LOOPS = [10, 20, 30, 60, 120, 240];

/**
 * How many requests one light may use per hour for a moving look. Eight lights at this
 * rate for a five-hour evening is 3,000 requests, well inside Govee's daily allowance.
 */
export const MOTION_REQUESTS_PER_LIGHT_HOUR = 75;

type Renderable = Pick<Look, 'colors' | 'pattern' | 'segments' | 'motion'>;

export const canMove = (look: Pick<Look, 'colors' | 'motion'>): boolean => !!look.motion && look.colors.length > 1;

/** The palette advanced round its loop: at phase 1/n every colour has become its neighbour. */
export function rotatePalette(colors: RGB[], phase: number): RGB[] {
  if (!phase || colors.length < 2) return colors;
  return colors.map((_, i) => sampleLoop(colors, i / colors.length + phase));
}

/**
 * Colours for one light.
 * @param segments how many segments the light has (0 or 1 means a single colour)
 * @param index position of this light among the lights the look is applied to
 * @param phase for a moving look, how far round its loop it is, from 0 to 1
 */
export function renderLook(look: Renderable, segments: number, index = 0, phase = 0): RGB[] {
  const base = look.colors.length ? look.colors : [0xffffff];
  const moving = canMove(look);
  // Motion is the palette slowly rotating; the pattern itself stays where it is.
  const palette = moving ? rotatePalette(base, phase) : base;
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
      let painted = look.segments?.length ? look.segments : base;
      // Each painted colour follows its place in the palette as the palette rotates.
      if (moving) painted = painted.map((c) => (base.indexOf(c) >= 0 ? palette[base.indexOf(c)] : c));
      return n === 1 ? [painted[Math.floor(painted.length / 2)]] : resample(painted, n);
    }
    case 'gradient':
    default: {
      if (n === 1) return [own];
      if (palette.length === 1) return Array(n).fill(palette[0]);
      const bands = Math.min(n, Math.max(palette.length, moving ? MOTION_BANDS : MAX_BANDS));
      const steps = Array.from({ length: bands }, (_, i) => sampleGradient(palette, bands === 1 ? 0 : i / (bands - 1)));
      return resample(steps, n);
    }
  }
}

/** Requests one step of a moving look costs for a light: one per distinct colour on it. */
export function frameCost(look: Renderable, segments: number, index = 0): number {
  return new Set(renderLook(look, segments, index, 0.123)).size;
}

/**
 * Seconds between steps of a moving look. Short enough to look gradual, long enough
 * that each light stays within its hourly request allowance.
 * @param lights segment count of each light the look is applied to
 */
export function motionStepSeconds(look: Renderable, lights: number[]): number {
  if (!look.motion) return 0;
  const gradual = (look.motion.loopMinutes * 60) / (Math.max(2, look.colors.length) * 8);
  const cost = Math.max(1, ...lights.map((segments, i) => frameCost(look, segments, i)));
  const allowance = (cost * 3600) / MOTION_REQUESTS_PER_LIGHT_HOUR;
  return Math.round(Math.max(30, gradual, allowance) / 5) * 5;
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
const starter = (id: string, name: string, pattern: LookPattern, colors: RGB[], brightness: number | null = null, loopMinutes?: number): Look => ({
  id,
  name,
  colors,
  pattern,
  brightness,
  ...(loopMinutes ? { motion: { loopMinutes } } : {}),
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
  starter('starter-drift', 'Drifting aurora', 'perLight', [0x19ff8c, 0x00c2ff, 0x8a4dff, 0xff4dd2], null, 30),
  starter('starter-embers', 'Slow embers', 'solid', [0xff2a00, 0xff7a00, 0xffb000], 60, 20),
];
