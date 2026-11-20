import type { RGB } from './types';

export const rgbOf = (r: number, g: number, b: number): RGB =>
  ((Math.round(r) & 255) << 16) | ((Math.round(g) & 255) << 8) | (Math.round(b) & 255);

export const parts = (c: RGB): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

export const toHex = (c: RGB): string => '#' + (c & 0xffffff).toString(16).padStart(6, '0');

/** Parses "#rgb", "#rrggbb" or the same without the hash. Returns null when malformed. */
export function fromHex(text: string): RGB | null {
  let s = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, (ch) => ch + ch);
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return parseInt(s, 16);
}

/** h in [0, 360), s and v in [0, 1]. */
export function hsvToRgb(h: number, s: number, v: number): RGB {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return rgbOf((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

export function rgbToHsv(color: RGB): { h: number; s: number; v: number } {
  const [r, g, b] = parts(color).map((n) => n / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

const toLinear = (n: number) => Math.pow(n / 255, 2.2);
const fromLinear = (n: number) => Math.pow(Math.max(0, Math.min(1, n)), 1 / 2.2) * 255;

/** Blends in linear light so midpoints stay bright instead of going muddy. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  const pa = parts(a);
  const pb = parts(b);
  const out = pa.map((n, i) => fromLinear(toLinear(n) * (1 - t) + toLinear(pb[i]) * t));
  return rgbOf(out[0], out[1], out[2]);
}

/** Samples a multi-stop gradient at t in [0, 1]. */
export function sampleGradient(stops: RGB[], t: number): RGB {
  if (stops.length === 0) return 0xffffff;
  if (stops.length === 1) return stops[0];
  const pos = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  return mix(stops[i], stops[i + 1], pos - i);
}

/** Approximate on-screen colour of a white at the given temperature. */
export function kelvinToRgb(kelvin: number): RGB {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  return rgbOf(clamp(r), clamp(g), clamp(b));
}

/** Perceived lightness 0..1, used to pick readable text over a colour. */
export function luminance(c: RGB): number {
  const [r, g, b] = parts(c).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Resamples a list of colours to a different length, keeping block edges crisp. */
export function resample(colors: RGB[], count: number): RGB[] {
  if (count <= 0 || colors.length === 0) return [];
  if (colors.length === count) return colors.slice();
  return Array.from({ length: count }, (_, i) => colors[Math.min(colors.length - 1, Math.floor(((i + 0.5) / count) * colors.length))]);
}
