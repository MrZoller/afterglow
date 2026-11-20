import { hsvToRgb, parts, rgbOf, rgbToHsv } from '../../shared/color';
import type { RGB } from '../../shared/types';

/**
 * Pulls a few dominant colours out of a photo with k-means, then pushes them to full
 * brightness so they suit LEDs (a dark brown in a photo is an orange on a light).
 */
export async function paletteFromImage(file: File, count = 5): Promise<RGB[]> {
  const bitmap = await createImageBitmap(file);
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  // Greys and near-blacks say little about the mood of a photo, so they are left out.
  const pixels: [number, number, number][] = [];
  for (let i = 0; i < data.length; i += 4) {
    const { s, v } = rgbToHsv(rgbOf(data[i], data[i + 1], data[i + 2]));
    if (data[i + 3] > 200 && s > 0.2 && v > 0.2) pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (pixels.length < count) return [0xffffff];

  let centers = Array.from({ length: count }, (_, i) => pixels[Math.floor(((i + 0.5) / count) * pixels.length)].slice() as [number, number, number]);
  let weights: number[] = [];
  for (let round = 0; round < 8; round++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const p of pixels) {
      let best = 0;
      let bestDist = Infinity;
      centers.forEach((c, i) => {
        const dist = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      const s = sums[best];
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3] += 1;
    }
    centers = sums.map((s, i) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centers[i]));
    weights = sums.map((s) => s[3]);
  }

  const vivid = centers
    .map((c, i) => ({ hsv: rgbToHsv(rgbOf(c[0], c[1], c[2])), weight: weights[i] }))
    .filter((c) => c.weight > 0)
    .map((c) => ({ ...c, rgb: hsvToRgb(c.hsv.h, Math.min(1, c.hsv.s * 1.25 + 0.1), 1) }));

  // Drop near-duplicates, then order by hue so gradients flow.
  const unique: typeof vivid = [];
  for (const c of vivid.sort((a, b) => b.weight - a.weight)) {
    const close = unique.some((u) => {
      const [r1, g1, b1] = parts(u.rgb);
      const [r2, g2, b2] = parts(c.rgb);
      return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) < 70;
    });
    if (!close) unique.push(c);
  }
  return unique.sort((a, b) => a.hsv.h - b.hsv.h).map((c) => c.rgb);
}
