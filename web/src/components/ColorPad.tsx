import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { fromHex, hsvToRgb, rgbToHsv, toHex } from '../../../shared/color';
import type { RGB } from '../../../shared/types';
import { clamp } from '../util';

/**
 * Hue runs left to right and saturation top to bottom. Brightness is deliberately not
 * here: lights have their own brightness control.
 */
export function ColorPad({ value, onChange, onCommit }: { value: RGB; onChange?: (c: RGB) => void; onCommit: (c: RGB) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => toPos(value));
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState(toHex(value));

  // Follow outside changes, but not while the user is mid-drag.
  useEffect(() => {
    if (dragging) return;
    if (hsvToRgb(pos.x * 360, 1 - pos.y, 1) !== value) setPos(toPos(value));
    setText(toHex(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, dragging]);

  const colorAt = (p: { x: number; y: number }) => hsvToRgb(p.x * 360, 1 - p.y, 1);

  const move = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const next = { x: clamp((e.clientX - rect.left) / rect.width, 0, 0.9999), y: clamp((e.clientY - rect.top) / rect.height, 0, 1) };
    setPos(next);
    onChange?.(colorAt(next));
    return next;
  };

  const current = dragging ? colorAt(pos) : value;

  return (
    <div className="colorpad-wrap">
      <div
        ref={ref}
        className="colorpad"
        role="application"
        aria-label="Colour picker. Drag to choose hue and saturation."
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          move(e);
        }}
        onPointerMove={(e) => dragging && move(e)}
        onPointerUp={(e) => {
          if (!dragging) return;
          const p = move(e);
          setDragging(false);
          onCommit(colorAt(p));
        }}
        onPointerCancel={() => setDragging(false)}
      >
        <span className="colorpad-thumb" style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%`, '--c': toHex(current) } as CSSProperties} />
      </div>
      <div className="colorpad-row">
        <span className="swatch lg" style={{ '--c': toHex(current) } as CSSProperties} />
        <input
          className="input hex"
          aria-label="Hex colour"
          value={dragging ? toHex(current) : text}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            const parsed = fromHex(e.target.value);
            if (parsed !== null && e.target.value.replace('#', '').length === 6) onCommit(parsed);
          }}
          onBlur={() => setText(toHex(value))}
        />
      </div>
    </div>
  );
}

function toPos(color: RGB) {
  const { h, s } = rgbToHsv(color);
  return { x: h / 360, y: 1 - s };
}
