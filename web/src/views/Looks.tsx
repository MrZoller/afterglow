import { useRef, useState, type CSSProperties } from 'react';
import { toHex } from '../../../shared/color';
import { PATTERNS, renderLook } from '../../../shared/looks';
import type { Action, Look, LookPattern, RGB } from '../../../shared/types';
import { ColorPad } from '../components/ColorPad';
import { Strip } from '../components/Strip';
import { Empty, Field, Group, Sheet, Slider, Toggle } from '../components/ui';
import { CloseIcon, ImageIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from '../icons';
import { paletteFromImage } from '../palette';
import { api, attempt, control, toast, useSnap } from '../store';
import { MODEL_NAMES } from '../util';

type Draft = Pick<Look, 'name' | 'colors' | 'pattern' | 'segments' | 'brightness'>;

/** A look drawn as it would appear: one rope, or several lights for the one-per-light pattern. */
export function LookPreview({ look, size = 'md' }: { look: Pick<Look, 'colors' | 'pattern' | 'segments'>; size?: 'sm' | 'md' | 'lg' }) {
  if (look.pattern === 'perLight' && look.colors.length > 1) {
    return (
      <div className="look-multi">
        {look.colors.slice(0, 4).map((c, i) => (
          <Strip key={i} colors={[c]} on size={size} />
        ))}
      </div>
    );
  }
  return <Strip colors={renderLook(look, 15)} on size={size} />;
}

export function patternLabel(pattern: LookPattern): string {
  return PATTERNS.find((p) => p.id === pattern)?.label ?? pattern;
}

/** Sheet listing everything a look or scene can be applied to. */
export function ApplySheet({ title, onPick, onClose }: { title: string; onPick: (target: string) => void; onClose: () => void }) {
  const snap = useSnap();
  const row = (target: string, label: string, hint: string) => (
    <button key={target} type="button" className="row-btn" onClick={() => onPick(target)}>
      <span>{label}</span>
      <small>{hint}</small>
    </button>
  );
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="rows">
        {row('all', 'All lights', `${snap.devices.length} lights`)}
        {snap.groups.map((g) => row(`group:${g.id}`, g.name, `Zone · ${g.deviceIds.length}`))}
        {snap.devices.map((d) => row(d.id, d.name, MODEL_NAMES[d.kind]))}
      </div>
    </Sheet>
  );
}

export function LooksView({ edit }: { edit: (look: Look | null) => void }) {
  const { looks } = useSnap();
  const [applying, setApplying] = useState<Look | null>(null);

  return (
    <>
      <header className="page-head">
        <h1>Looks</h1>
        <button type="button" className="btn primary" onClick={() => edit(null)}>
          <PlusIcon size={18} /> New look
        </button>
      </header>
      <p className="muted lead">Your own colour designs. Pick a palette and how it spreads across the lights, then use it anywhere, including in schedules.</p>

      {looks.length === 0 ? (
        <Empty title="No looks yet">
          <p>Create one from colours you choose, or from a photo.</p>
        </Empty>
      ) : (
        <div className="grid">
          {looks.map((look) => (
            <article key={look.id} className="card look-card">
              <LookPreview look={look} size="lg" />
              <div className="look-meta">
                <div>
                  <h3>{look.name}</h3>
                  <p className="sub">
                    {patternLabel(look.pattern)}
                    {look.brightness !== null && ` · ${look.brightness}%`}
                  </p>
                </div>
                <button type="button" className="icon-btn" aria-label={`Edit ${look.name}`} onClick={() => edit(look)}>
                  <PencilIcon size={18} />
                </button>
                <button type="button" className="btn sm" onClick={() => setApplying(look)}>
                  <PlayIcon size={14} /> Apply
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {applying && (
        <ApplySheet
          title={`Apply “${applying.name}” to`}
          onClose={() => setApplying(null)}
          onPick={(target) => {
            void control([target], { type: 'look', lookId: applying.id });
            setApplying(null);
          }}
        />
      )}
    </>
  );
}

const NEW_LOOK: Draft = { name: '', colors: [0xff5d3d, 0xffc94d, 0x7b6cff], pattern: 'gradient', brightness: null };

export function LookEditor({ look, onClose, tryOn = 'all' }: { look: Look | null; onClose: () => void; tryOn?: string }) {
  const snap = useSnap();
  const [draft, setDraft] = useState<Draft>(() => (look ? { name: look.name, colors: look.colors, pattern: look.pattern, segments: look.segments, brightness: look.brightness } : NEW_LOOK));
  const [selected, setSelected] = useState(0);
  const [target, setTarget] = useState(tryOn);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setColor = (index: number, color: RGB) => update({ colors: draft.colors.map((c, i) => (i === index ? color : c)) });
  const index = Math.min(selected, draft.colors.length - 1);
  const patterns = PATTERNS.filter((p) => p.id !== 'custom' || look?.pattern === 'custom');

  const body = (): Draft => ({ ...draft, name: draft.name.trim(), segments: draft.pattern === 'custom' ? draft.segments : undefined });

  const save = async () => {
    if (!draft.name.trim()) return toast('Give the look a name first', 'error');
    setBusy(true);
    const saved = await attempt(look ? api('PUT', `/looks/${look.id}`, body()) : api('POST', '/looks', body()));
    setBusy(false);
    if (saved) onClose();
  };

  const tryIt = () => {
    const action: Action = { type: 'palette', colors: draft.colors, pattern: draft.pattern, segments: body().segments, brightness: draft.brightness };
    void control([target], action);
  };

  const fromPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const colors = await paletteFromImage(file);
      update({ colors, pattern: draft.pattern === 'custom' || draft.pattern === 'solid' ? 'gradient' : draft.pattern });
      setSelected(0);
    } catch {
      toast('Could not read that image', 'error');
    }
  };

  return (
    <Sheet
      title={look ? 'Edit look' : 'New look'}
      onClose={onClose}
      footer={
        <>
          {look &&
            (confirmDelete ? (
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  if (await attempt(api('DELETE', `/looks/${look.id}`))) onClose();
                }}
              >
                Really delete
              </button>
            ) : (
              <button type="button" className="icon-btn danger" aria-label="Delete look" onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={18} />
              </button>
            ))}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            Save look
          </button>
        </>
      }
    >
      <div className="form">
        <div className="preview-stage">
          <LookPreview look={draft} size="lg" />
        </div>

        <Field label="Name">
          <input className="input" value={draft.name} placeholder="e.g. Game night" maxLength={60} onChange={(e) => update({ name: e.target.value })} />
        </Field>

        <Group label="Colours" hint={draft.pattern === 'custom' ? 'This look was painted by hand; choosing another pattern replaces the painting with these colours.' : undefined}>
          <div className="palette">
            {draft.colors.map((c, i) => (
              <span key={i} className="palette-item">
                <button type="button" className="swatch xl" aria-label={`Colour ${i + 1}: ${toHex(c)}`} aria-pressed={i === index} style={{ '--c': toHex(c) } as CSSProperties} onClick={() => setSelected(i)} />
                {draft.colors.length > 1 && i === index && (
                  <button
                    type="button"
                    className="palette-remove"
                    aria-label={`Remove colour ${i + 1}`}
                    onClick={() => {
                      update({ colors: draft.colors.filter((_, j) => j !== i) });
                      setSelected(Math.max(0, i - 1));
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                )}
              </span>
            ))}
            {draft.colors.length < 8 && (
              <button
                type="button"
                className="swatch xl add"
                aria-label="Add a colour"
                onClick={() => {
                  update({ colors: [...draft.colors, draft.colors[index]] });
                  setSelected(draft.colors.length);
                }}
              >
                <PlusIcon size={18} />
              </button>
            )}
            <button type="button" className="btn ghost sm" onClick={() => fileRef.current?.click()}>
              <ImageIcon size={16} /> From photo
            </button>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void fromPhoto(e.target.files?.[0])} />
          </div>
          <ColorPad value={draft.colors[index]} onChange={(c) => setColor(index, c)} onCommit={(c) => setColor(index, c)} />
        </Group>

        <Group label="Pattern">
          <div className="options">
            {patterns.map((p) => (
              <button key={p.id} type="button" className="option" aria-pressed={draft.pattern === p.id} onClick={() => update({ pattern: p.id })}>
                <LookPreview look={{ ...draft, pattern: p.id }} size="sm" />
                <strong>{p.label}</strong>
                <small>{p.hint}</small>
              </button>
            ))}
          </div>
        </Group>

        <Group label="Brightness">
          <div className="inline">
            <Toggle on={draft.brightness !== null} label="Set brightness with this look" onChange={(on) => update({ brightness: on ? 80 : null })} />
            <span className="muted">{draft.brightness === null ? 'Leave brightness as it is' : 'Set brightness when applied'}</span>
          </div>
          {draft.brightness !== null && <Slider label="Look brightness" value={draft.brightness} onChange={(v) => update({ brightness: v })} onCommit={(v) => update({ brightness: v })} />}
        </Group>

        <Group label="Try it on the lights" hint="Shows the design without saving it.">
          <div className="inline">
            <select className="input" aria-label="Lights to try on" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="all">All lights</option>
              {snap.groups.map((g) => (
                <option key={g.id} value={`group:${g.id}`}>
                  {g.name}
                </option>
              ))}
              {snap.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={tryIt}>
              <PlayIcon size={14} /> Try
            </button>
          </div>
        </Group>
      </div>
    </Sheet>
  );
}
