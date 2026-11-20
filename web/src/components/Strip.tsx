import type { CSSProperties } from 'react';
import { resample, toHex } from '../../../shared/color';
import type { DeviceKind, RGB } from '../../../shared/types';

/** CSS gradient that reads like a diffused LED strip: colours meet softly at segment edges. */
export function stripGradient(colors: RGB[]): string {
  if (colors.length === 0) return 'transparent';
  if (colors.length === 1) return toHex(colors[0]);
  const stops = colors.map((c, i) => `${toHex(c)} ${(((i + 0.5) / colors.length) * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * Picture of a light: a glowing bar for rope lights, a row of lamps for garden lights.
 * `scene` draws an animated shimmer because the real colours of a scene are not known.
 */
export function Strip({ colors, on, kind = 'rope', scene, size = 'md' }: { colors: RGB[]; on: boolean; kind?: DeviceKind; scene?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const lit = on && (scene || colors.length > 0);
  const cls = `strip ${kind === 'garden' ? 'garden' : 'rope'} ${size}${lit ? '' : ' off'}${on && scene ? ' shimmer' : ''}`;

  if (kind === 'garden') {
    const lamps = lit && !scene ? resample(colors, Math.min(8, Math.max(colors.length, 6))) : Array<RGB>(6).fill(0);
    return (
      <div className={cls} aria-hidden="true">
        {lamps.map((c, i) => (
          <i key={i} style={lit && !scene ? ({ '--c': toHex(c) } as CSSProperties) : ({ '--i': i } as CSSProperties)} />
        ))}
      </div>
    );
  }

  return (
    <div className={cls} aria-hidden="true" style={lit && !scene ? ({ '--paint': stripGradient(colors) } as CSSProperties) : undefined}>
      <span className="strip-glow" />
      <span className="strip-bar" />
    </div>
  );
}
