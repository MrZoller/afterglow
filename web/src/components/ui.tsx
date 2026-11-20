import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CloseIcon } from '../icons';
import { useApp } from '../store';
import { clamp } from '../util';

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className="toggle"
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      <span />
    </button>
  );
}

/**
 * A wide, thumb-friendly slider. `onChange` fires while dragging; `onCommit` fires once
 * on release, which is when a command should be sent.
 */
export function Slider({
  value,
  min = 1,
  max = 100,
  step = 1,
  label,
  onChange,
  onCommit,
  format = (v) => `${v}%`,
  track,
  disabled,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  onChange?: (v: number) => void;
  onCommit: (v: number) => void;
  format?: (v: number) => string;
  /** CSS background for the track, e.g. a warm-to-cool gradient. */
  track?: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? value;
  const fraction = clamp((shown - min) / (max - min), 0, 1);

  const at = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const raw = min + clamp((clientX - rect.left) / rect.width, 0, 1) * (max - min);
    return clamp(Math.round(raw / step) * step, min, max);
  };

  return (
    <div
      ref={ref}
      className={`slider${track ? ' tracked' : ''}${disabled ? ' disabled' : ''}`}
      style={{ '--fill': `${fraction * 100}%`, ...(track ? { '--track': track } : {}) } as CSSProperties}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={format(shown)}
      aria-disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const v = at(e.clientX);
        setDrag(v);
        onChange?.(v);
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const v = at(e.clientX);
        if (v !== drag) {
          setDrag(v);
          onChange?.(v);
        }
      }}
      onPointerUp={() => {
        if (drag === null) return;
        onCommit(drag);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={(e) => {
        const big = (max - min) / 10;
        const delta = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: big, PageDown: -big }[e.key];
        if (delta === undefined || disabled) return;
        e.preventDefault();
        onCommit(clamp(Math.round((value + delta) / step) * step, min, max));
      }}
    >
      <div className="slider-fill" />
      <div className="slider-thumb" />
      <span className="slider-value">{format(shown)}</span>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A sheet that slides up from the bottom on phones. On wide screens it is a side panel
 * (`side`) or a centred dialog.
 */
export function Sheet({ title, subtitle, onClose, children, side, actions, footer }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; side?: boolean; actions?: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Leave focus alone when a field inside asked for it (autoFocus).
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('sheet-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      if (!document.querySelector('.sheet-backdrop')) document.body.classList.remove('sheet-open');
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`sheet${side ? ' side' : ''}`} role="dialog" aria-modal="true" tabIndex={-1}>
        <header className="sheet-head">
          <div className="sheet-title">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** A group of related controls with a heading, for fieldsets that are not a single input. */
export function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
