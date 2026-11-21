import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { toHex } from '../../../shared/color';
import { canMove, frameCost, MOTION_LOOPS, motionStepSeconds, PATTERNS, renderLook } from '../../../shared/looks';
import type { Action, Look, LookIdea, LookPattern, LookSuggestions, RGB } from '../../../shared/types';
import { ColorPad } from '../components/ColorPad';
import { Strip } from '../components/Strip';
import { Empty, Field, Group, Sheet, Slider, Toggle } from '../components/ui';
import { CloseIcon, ImageIcon, PencilIcon, PlayIcon, PlusIcon, SparkIcon, TrashIcon } from '../icons';
import { paletteFromImage } from '../palette';
import { api, attempt, control, targetDevices, toast, useSnap } from '../store';
import { describeTargets, MODEL_NAMES, plural } from '../util';

type Draft = Pick<Look, 'name' | 'colors' | 'pattern' | 'segments' | 'brightness' | 'motion'>;

/**
 * Runs from 0 to 1 over and over, so a moving look can be previewed in seconds rather
 * than the minutes it really takes.
 */
function usePhase(active: boolean, loopMs = 14_000): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhase(0);
      return;
    }
    const start = performance.now();
    let last = 0;
    let frame = requestAnimationFrame(function tick(now) {
      if (now - last > 80) {
        last = now;
        setPhase(((now - start) % loopMs) / loopMs);
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, loopMs]);
  return phase;
}

/**
 * A look drawn as it would appear: one rope, or several lights for the one-per-light
 * pattern. Moving looks play here much faster than on the lights.
 */
export function LookPreview({ look, size = 'md' }: { look: Pick<Look, 'colors' | 'pattern' | 'segments' | 'motion'>; size?: 'sm' | 'md' | 'lg' }) {
  const phase = usePhase(canMove(look));
  if (look.pattern === 'perLight' && look.colors.length > 1) {
    return (
      <div className="look-multi">
        {look.colors.slice(0, 4).map((_, i) => (
          <Strip key={i} colors={renderLook(look, 1, i, phase)} on size={size} />
        ))}
      </div>
    );
  }
  return <Strip colors={renderLook(look, 15, 0, phase)} on size={size} />;
}

export const loopLabel = (minutes: number) => (minutes < 60 ? `${minutes} min` : minutes % 60 === 0 ? plural(minutes / 60, 'hour') : `${(minutes / 60).toFixed(1)} hours`);

const stepLabel = (seconds: number) => (seconds < 90 ? `${seconds} seconds` : `${Number((seconds / 60).toFixed(1))} minutes`);

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

export function LooksView({ edit }: { edit: (look: Look | null, assist?: boolean) => void }) {
  const { looks, status } = useSnap();
  const [applying, setApplying] = useState<Look | null>(null);

  return (
    <>
      <header className="page-head">
        <h1>Looks</h1>
        {status.ai && (
          <button type="button" className="btn" aria-label="Describe a look" onClick={() => edit(null, true)}>
            <SparkIcon size={18} /> <span className="wide-only">Describe</span>
          </button>
        )}
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
                    {canMove(look) && ` · moves, ${loopLabel(look.motion!.loopMinutes)} loop`}
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

/**
 * Asks the assistant for look ideas from a description. Picking one loads it into the
 * editor, where it can be adjusted, tried on the lights and saved like any other look.
 */
function Assist({ current, target, autoFocus, onPick }: { current: Draft | null; target: string; autoFocus?: boolean; onPick: (idea: LookIdea) => void }) {
  const { status } = useSnap();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LookSuggestions | null>(null);
  const [picked, setPicked] = useState<number | null>(null);

  if (!status.ai) {
    return (
      <p className="muted small assist-off">
        <SparkIcon size={14} /> Want ideas from a description? Add an Anthropic API key as <code>ANTHROPIC_API_KEY</code> in the <code>.env</code> file and restart.
      </p>
    );
  }

  const ask = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    const body = { prompt: prompt.trim(), targets: [target], current: current && { name: current.name, colors: current.colors, pattern: current.pattern, brightness: current.brightness, motion: current.motion ?? null } };
    const next = await attempt(api<LookSuggestions>('POST', '/ai/looks', body));
    setBusy(false);
    if (next) {
      setResult(next);
      setPicked(null);
    }
  };

  return (
    <div className="assist">
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          className="input"
          autoFocus={autoFocus}
          aria-label="Describe the look you want"
          placeholder={current ? 'e.g. warmer, less purple' : 'e.g. cosy autumn evening'}
          maxLength={500}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={busy || !prompt.trim()}>
          <SparkIcon size={16} /> {busy ? 'Thinking…' : result ? 'Again' : 'Suggest'}
        </button>
      </form>
      {busy && <p className="muted small">Coming up with ideas. This usually takes a few seconds.</p>}
      {result && !busy && (
        <>
          <div className="options">
            {result.ideas.map((idea, i) => (
              <button
                key={i}
                type="button"
                className="option"
                aria-pressed={picked === i}
                onClick={() => {
                  setPicked(i);
                  onPick(idea);
                }}
              >
                <LookPreview look={idea} size="sm" />
                <strong>{idea.name}</strong>
                <small>{idea.note}</small>
              </button>
            ))}
          </div>
          {result.scenes.length > 0 && (
            <div className="assist-scenes">
              <span className="field-hint">Looks are still. For movement, these built-in scenes fit; tap one to play it:</span>
              <div className="chips">
                {result.scenes.map((scene) => (
                  <button key={scene.name} type="button" className="chip" onClick={() => void control([target], { type: 'scene', scene })}>
                    <PlayIcon size={12} /> {scene.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const NEW_LOOK: Draft = { name: '', colors: [0xff5d3d, 0xffc94d, 0x7b6cff], pattern: 'gradient', brightness: null, motion: null };

export function LookEditor({ look, onClose, tryOn = 'all', assist }: { look: Look | null; onClose: () => void; tryOn?: string; assist?: boolean }) {
  const snap = useSnap();
  const [draft, setDraft] = useState<Draft>(() => (look ? { name: look.name, colors: look.colors, pattern: look.pattern, segments: look.segments, brightness: look.brightness, motion: look.motion ?? null } : NEW_LOOK));
  const [selected, setSelected] = useState(0);
  const [target, setTarget] = useState(tryOn);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Until something changes, a new look is only the starting palette and should not steer suggestions.
  const [touched, setTouched] = useState(!!look);
  const update = (patch: Partial<Draft>) => {
    setTouched(true);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const painted = draft.pattern === 'custom' && !!draft.segments?.length;
  const setColor = (index: number, color: RGB) => {
    const old = draft.colors[index];
    update({
      colors: draft.colors.map((c, i) => (i === index ? color : c)),
      // In a painted design, changing a colour recolours every segment that used it.
      // Otherwise the palette no longer matches any earlier painting, so that is dropped.
      segments: painted ? draft.segments!.map((c) => (c === old ? color : c)) : undefined,
    });
  };
  const index = Math.min(selected, draft.colors.length - 1);
  const patterns = PATTERNS.filter((p) => p.id !== 'custom' || !!draft.segments?.length);

  const body = (): Draft => ({ ...draft, name: draft.name.trim(), segments: draft.pattern === 'custom' ? draft.segments : undefined, motion: draft.motion ?? null });

  // What movement will mean on the lights chosen under "Try it".
  const movement = (() => {
    if (!draft.motion) return null;
    if (draft.colors.length < 2) return 'Add a second colour for the look to move between.';
    const lights = targetDevices(snap, [target]);
    const step = motionStepSeconds(draft, lights.map((d) => d.caps.segments));
    const perHour = Math.round(lights.reduce((sum, d, i) => sum + (frameCost(draft, d.caps.segments, i) * 3600) / step, 0));
    const effect = draft.pattern === 'solid' ? 'The lights change colour together' : draft.pattern === 'perLight' ? 'Colours travel from light to light' : 'Colours flow along each light';
    return `${effect}, a small step about every ${stepLabel(step)}. On ${describeTargets([target], snap).toLowerCase()} that is roughly ${perHour} requests an hour. The preview at the top is sped up.`;
  })();

  const save = async () => {
    if (!draft.name.trim()) return toast('Give the look a name first', 'error');
    setBusy(true);
    const saved = await attempt(look ? api('PUT', `/looks/${look.id}`, body()) : api('POST', '/looks', body()));
    setBusy(false);
    if (saved) onClose();
  };

  const tryIt = () => {
    const action: Action = { type: 'palette', colors: draft.colors, pattern: draft.pattern, segments: body().segments, brightness: draft.brightness, motion: draft.motion ?? null };
    void control([target], action);
  };

  const fromPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const colors = await paletteFromImage(file);
      update({ colors, segments: undefined, pattern: draft.pattern === 'custom' || draft.pattern === 'solid' ? 'gradient' : draft.pattern });
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
        <Assist
          current={touched ? draft : null}
          target={target}
          autoFocus={assist}
          onPick={(idea) => {
            // An existing look keeps its name; a new one takes the idea's.
            update({ name: look ? draft.name : idea.name, colors: idea.colors, pattern: idea.pattern, segments: idea.segments, brightness: idea.brightness, motion: idea.motion ?? null });
            setSelected(0);
          }}
        />

        <div className="preview-stage">
          <LookPreview look={draft} size="lg" />
        </div>

        <Field label="Name">
          <input className="input" value={draft.name} placeholder="e.g. Game night" maxLength={60} onChange={(e) => update({ name: e.target.value })} />
        </Field>

        <Group label="Colours" hint={painted ? 'This design is painted segment by segment. Change a colour to recolour it, or choose another pattern to use these colours differently.' : undefined}>
          <div className="palette">
            {draft.colors.map((c, i) => (
              <span key={i} className="palette-item">
                <button type="button" className="swatch xl" aria-label={`Colour ${i + 1}: ${toHex(c)}`} aria-pressed={i === index} style={{ '--c': toHex(c) } as CSSProperties} onClick={() => setSelected(i)} />
                {draft.colors.length > 1 && i === index && !painted && (
                  <button
                    type="button"
                    className="palette-remove"
                    aria-label={`Remove colour ${i + 1}`}
                    onClick={() => {
                      update({ colors: draft.colors.filter((_, j) => j !== i), segments: undefined });
                      setSelected(Math.max(0, i - 1));
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                )}
              </span>
            ))}
            {draft.colors.length < 8 && !painted && (
              <button
                type="button"
                className="swatch xl add"
                aria-label="Add a colour"
                onClick={() => {
                  update({ colors: [...draft.colors, draft.colors[index]], segments: undefined });
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

        <Group label="Movement" hint={movement ?? undefined}>
          <div className="inline">
            <Toggle on={!!draft.motion} label="Slowly move the colours" onChange={(on) => update({ motion: on ? { loopMinutes: 30 } : null })} />
            <span className="muted">{draft.motion ? 'Colours slowly move through the palette' : 'Still'}</span>
          </div>
          {draft.motion && (
            <select className="input" aria-label="Time for one full loop" value={draft.motion.loopMinutes} onChange={(e) => update({ motion: { loopMinutes: Number(e.target.value) } })}>
              {[...new Set([...MOTION_LOOPS, draft.motion.loopMinutes])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    One full loop every {loopLabel(m)}
                  </option>
                ))}
            </select>
          )}
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
