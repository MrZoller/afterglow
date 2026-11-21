import { resample, sampleGradient, sampleLoop } from './color';
import type { Group, Look, LookPattern, RGB } from './types';

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

/** Where one light sits when a design is applied: on its own, or as part of a run of lights joined end to end. */
export interface Placement {
  /** The light's own segment count (0 or 1 means it shows a single colour). */
  segments: number;
  /** Position of this light, or of the run it belongs to, among everything the design is applied to. */
  index: number;
  /** For a light in a run: where its segments start within the run, and the run's total length. */
  offset?: number;
  total?: number;
  /** True when the light is mounted with its last segment where the design should start. */
  reversed?: boolean;
}

export interface PlaceableLight {
  id: string;
  segments: number;
  reversed: boolean;
}

/**
 * Works out how a design spreads over the lights it is applied to. A zone marked as
 * joined counts as one long light, provided every one of its lights is included;
 * a single rope from a pair, targeted on its own, is treated as a light by itself.
 * @param lights the lights the design is applied to, in order
 * @param exists whether a light id still refers to a real light (zones may list removed ones)
 */
export function placeLights(lights: PlaceableLight[], groups: Pick<Group, 'deviceIds' | 'joined'>[], exists: (id: string) => boolean = () => true): Map<string, Placement> {
  const byId = new Map(lights.map((l) => [l.id, l]));
  const runOf = new Map<string, string[]>();
  for (const group of groups) {
    if (!group.joined) continue;
    const members = group.deviceIds.filter(exists);
    if (members.length < 2 || !members.every((id) => byId.has(id)) || members.some((id) => runOf.has(id))) continue;
    members.forEach((id) => runOf.set(id, members));
  }

  const width = (id: string) => Math.max(1, byId.get(id)!.segments);
  const placed = new Map<string, Placement>();
  let index = 0;
  for (const light of lights) {
    if (placed.has(light.id)) continue;
    const members = runOf.get(light.id);
    if (!members) {
      placed.set(light.id, { segments: light.segments, index: index++, reversed: light.reversed });
      continue;
    }
    const total = members.reduce((sum, id) => sum + width(id), 0);
    let offset = 0;
    for (const id of members) {
      placed.set(id, { segments: byId.get(id)!.segments, index, offset, total, reversed: byId.get(id)!.reversed });
      offset += width(id);
    }
    index++;
  }
  return placed;
}

const cut = (colors: RGB[], p: Placement): RGB[] => {
  const mine = p.total === undefined ? colors : colors.slice(p.offset ?? 0, (p.offset ?? 0) + Math.max(1, p.segments));
  return p.reversed ? mine.reverse() : mine;
};

/** Colours for a light given its placement: its own share of a run, flipped if it is mounted backwards. */
export function renderPlaced(look: Renderable, p: Placement, phase = 0): RGB[] {
  return cut(renderLook(look, p.total ?? p.segments, p.index, phase), p);
}

/** The part of a hand-painted design that falls on a light, stretched to fit the light or its run. */
export function placeColors(colors: RGB[], p: Placement): RGB[] {
  const length = p.total ?? Math.max(1, p.segments);
  const full = length === 1 ? [colors[Math.floor(colors.length / 2)]] : resample(colors, length);
  return cut(full, p);
}

/** Requests one step of a moving look costs for a light: one per distinct colour on it. */
export function frameCost(look: Renderable, segments: number, index = 0): number {
  return placedCost(look, { segments, index });
}

export function placedCost(look: Renderable, p: Placement): number {
  return new Set(renderPlaced(look, p, 0.123)).size;
}

/**
 * Seconds between steps of a moving look on one light: short enough to look gradual,
 * and for cloud commands long enough that the light stays within its hourly allowance.
 * @param local true when this light's frames go over the local network, which has no
 *   request limit. That is always possible for a single colour, and for several colours
 *   only where the owner has switched on local designs for the model.
 */
export function placedStepSeconds(look: Renderable, p: Placement, local = false): number {
  if (!look.motion) return 0;
  const loop = look.motion.loopMinutes * 60;
  const colours = Math.max(2, look.colors.length);
  const cost = placedCost(look, p);
  // Locally there is nothing to ration, so take many small steps: 60 between neighbouring colours.
  if (local) return Math.max(5, Math.min(60, Math.round(loop / (colours * 60))));
  const gradual = loop / (colours * 8);
  const allowance = (cost * 3600) / MOTION_REQUESTS_PER_LIGHT_HOUR;
  return Math.round(Math.max(30, gradual, allowance) / 5) * 5;
}

/** As placedStepSeconds, for a light on its own. */
export function motionStepSeconds(look: Renderable, segments: number, index = 0, local = false): number {
  return placedStepSeconds(look, { segments, index }, local);
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
