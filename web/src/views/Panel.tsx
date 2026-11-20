import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { kelvinToRgb, resample, toHex } from '../../../shared/color';
import type { Device, Look, RGB, SceneChoice, SceneKind } from '../../../shared/types';
import { ColorPad } from '../components/ColorPad';
import { Field, Segmented, Sheet, Slider, Toggle } from '../components/ui';
import { CheckIcon, PencilIcon, PlusIcon, RefreshIcon, SparkIcon } from '../icons';
import { api, attempt, control, targetDevices, toast, useSnap } from '../store';
import { deviceColors, plural } from '../util';
import { LookPreview } from './Looks';

type Tab = 'looks' | 'scenes' | 'color' | 'white' | 'paint';

const TABS: { id: Tab; label: string }[] = [
  { id: 'looks', label: 'Looks' },
  { id: 'scenes', label: 'Scenes' },
  { id: 'color', label: 'Colour' },
  { id: 'white', label: 'White' },
  { id: 'paint', label: 'Paint' },
];

const WHITES = [
  { label: 'Candle', kelvin: 2000 },
  { label: 'Warm', kelvin: 2700 },
  { label: 'Soft', kelvin: 3500 },
  { label: 'Neutral', kelvin: 4500 },
  { label: 'Daylight', kelvin: 6500 },
];

const SCENE_KINDS: { id: SceneKind; label: string }[] = [
  { id: 'light', label: 'Built-in' },
  { id: 'diy', label: 'DIY' },
  { id: 'snapshot', label: 'Snapshots' },
];

export function ControlPanel({ target, onClose, editLook, editZone }: { target: string; onClose: () => void; editLook: (look: Look | null, tryOn: string) => void; editZone: (id: string) => void }) {
  const snap = useSnap();
  const devices = targetDevices(snap, [target]);
  const group = target.startsWith('group:') ? snap.groups.find((g) => g.id === target.slice(6)) : undefined;
  const title = target === 'all' ? 'All lights' : (group?.name ?? devices[0]?.name ?? 'Lights');
  const [tab, setTab] = useState<Tab>('looks');

  const exists = target === 'all' || !!group || devices.length > 0;
  useEffect(() => {
    if (!exists) onClose();
  }, [exists, onClose]);

  const on = devices.some((d) => d.state.power);
  const lit = devices.filter((d) => d.state.power && d.state.brightness !== null);
  const brightness = lit.length ? Math.round(lit.reduce((sum, d) => sum + d.state.brightness!, 0) / lit.length) : (devices.find((d) => d.state.brightness !== null)?.state.brightness ?? 100);
  const pending = devices.reduce((sum, d) => sum + d.pending, 0);

  return (
    <Sheet
      side
      title={title}
      subtitle={pending ? `Sending ${plural(pending, 'change')}…` : devices.length === 1 && !group && target !== 'all' ? devices[0].sku : plural(devices.length, 'light')}
      onClose={onClose}
      actions={
        <>
          {group && (
            <button type="button" className="icon-btn" aria-label="Edit zone" onClick={() => editZone(group.id)}>
              <PencilIcon size={18} />
            </button>
          )}
          <Toggle on={on} disabled={devices.length === 0} label={`${title} power`} onChange={(next) => void control([target], { type: 'power', on: next })} />
        </>
      }
    >
      <div className="panel">
        <Slider label="Brightness" value={brightness} disabled={devices.length === 0} onCommit={(value) => void control([target], { type: 'brightness', value })} />
        <Segmented label="Controls" value={tab} options={TABS} onChange={setTab} />

        {tab === 'looks' && <LooksTab target={target} devices={devices} editLook={editLook} />}
        {tab === 'scenes' && <ScenesTab target={target} devices={devices} />}
        {tab === 'color' && <ColorTab target={target} devices={devices} />}
        {tab === 'white' && <WhiteTab target={target} devices={devices} />}
        {tab === 'paint' && <PaintTab key={target} target={target} devices={devices} />}
      </div>
    </Sheet>
  );
}

function LooksTab({ target, devices, editLook }: { target: string; devices: Device[]; editLook: (look: Look | null, tryOn: string) => void }) {
  const { looks } = useSnap();
  const lit = devices.filter((d) => d.state.power);
  const active = (look: Look) => lit.length > 0 && lit.every((d) => d.state.lookId === look.id);

  return (
    <div className="tiles">
      {looks.map((look) => (
        <button key={look.id} type="button" className="tile" aria-pressed={active(look)} onClick={() => void control([target], { type: 'look', lookId: look.id })}>
          <LookPreview look={look} />
          <span>{look.name}</span>
        </button>
      ))}
      <button type="button" className="tile add" onClick={() => editLook(null, target)}>
        <PlusIcon />
        <span>New look</span>
      </button>
    </div>
  );
}

function ScenesTab({ target, devices }: { target: string; devices: Device[] }) {
  const [data, setData] = useState<{ scenes: SceneChoice[]; lights: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<SceneKind>('light');
  const [query, setQuery] = useState('');

  const load = (reload = false) => {
    setError(null);
    if (reload) setData(null);
    api<{ scenes: SceneChoice[]; lights: number }>('GET', `/scenes?targets=${encodeURIComponent(target)}${reload ? '&reload=1' : ''}`).then(setData, (err: Error) => setError(err.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [target]);

  const lit = devices.filter((d) => d.state.power);
  const active = (s: SceneChoice) => lit.length > 0 && lit.some((d) => d.state.appearance.mode === 'scene' && d.state.appearance.scene.kind === s.kind && d.state.appearance.scene.name === s.name);

  if (error) {
    return (
      <div className="notice error">
        <p>Could not load scenes: {error}</p>
        <button type="button" className="btn sm" onClick={() => load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) return <p className="muted">Loading scenes…</p>;

  const kinds = SCENE_KINDS.filter((k) => data.scenes.some((s) => s.kind === k.id));
  const shownKind = kinds.some((k) => k.id === kind) ? kind : (kinds[0]?.id ?? 'light');
  const list = data.scenes.filter((s) => s.kind === shownKind && s.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="scenes">
      <div className="inline">
        {kinds.length > 1 && <Segmented label="Scene type" value={shownKind} options={kinds} onChange={setKind} />}
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="Reload scenes from Govee" title="Reload scenes from Govee" onClick={() => load(true)}>
          <RefreshIcon size={18} />
        </button>
      </div>
      {data.scenes.length > 12 && <input className="input" type="search" placeholder="Search scenes" aria-label="Search scenes" value={query} onChange={(e) => setQuery(e.target.value)} />}
      {data.scenes.length === 0 ? (
        <p className="muted">These lights did not report any scenes.</p>
      ) : list.length === 0 ? (
        <p className="muted">No scenes match “{query}”.</p>
      ) : (
        <div className="scene-grid">
          {list.map((s) => (
            <button key={`${s.kind}:${s.name}`} type="button" className="scene" aria-pressed={active(s)} onClick={() => void control([target], { type: 'scene', scene: { kind: s.kind, name: s.name } })}>
              <SparkIcon size={16} />
              <span>{s.name}</span>
              {s.supported < data.lights && (
                <small>
                  {s.supported} of {data.lights}
                </small>
              )}
            </button>
          ))}
        </div>
      )}
      {shownKind !== 'light' && <p className="muted small">DIY scenes and snapshots are made in the Govee app. Reload to pick up new ones.</p>}
    </div>
  );
}

function currentColor(devices: Device[]): RGB {
  for (const d of devices) {
    const a = d.state.appearance;
    if (a.mode === 'color') return a.rgb;
  }
  return 0xffb057;
}

function Swatches({ onPick, current }: { onPick: (c: RGB) => void; current?: RGB }) {
  const { settings } = useSnap();
  const [editing, setEditing] = useState(false);
  const save = (swatches: RGB[]) => void attempt(api('PUT', '/settings', { swatches }));

  return (
    <div className="swatches">
      {settings.swatches.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch lg${editing ? ' removing' : ''}`}
          style={{ '--c': toHex(c) } as CSSProperties}
          aria-label={editing ? `Remove ${toHex(c)}` : `Use ${toHex(c)}`}
          onClick={() => (editing ? save(settings.swatches.filter((s) => s !== c)) : onPick(c))}
        />
      ))}
      {current !== undefined && !editing && !settings.swatches.includes(current) && settings.swatches.length < 24 && (
        <button type="button" className="swatch lg add" aria-label="Save this colour" title="Save this colour" onClick={() => save([...settings.swatches, current])}>
          <PlusIcon size={16} />
        </button>
      )}
      {settings.swatches.length > 0 && (
        <button type="button" className="btn ghost sm" onClick={() => setEditing(!editing)}>
          {editing ? 'Done' : 'Edit'}
        </button>
      )}
    </div>
  );
}

function ColorTab({ target, devices }: { target: string; devices: Device[] }) {
  const value = currentColor(devices);
  const apply = (rgb: RGB) => void control([target], { type: 'color', rgb });
  return (
    <div className="stack">
      <ColorPad value={value} onCommit={apply} />
      <Field label="Saved colours">
        <Swatches onPick={apply} current={value} />
      </Field>
    </div>
  );
}

function WhiteTab({ target, devices }: { target: string; devices: Device[] }) {
  const range = devices.find((d) => d.caps.colorTemp)?.caps.colorTemp ?? { min: 2000, max: 9000 };
  const current = devices.map((d) => d.state.appearance).find((a) => a.mode === 'temp');
  const kelvin = current?.mode === 'temp' ? current.kelvin : 2700;
  const apply = (k: number) => void control([target], { type: 'colorTemp', kelvin: k });
  const track = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => toHex(kelvinToRgb(range.min + t * (range.max - range.min)))).join(', ')})`;

  return (
    <div className="stack">
      <Slider label="White temperature" value={kelvin} min={range.min} max={range.max} step={100} track={track} format={(v) => `${v}K`} onCommit={apply} />
      <div className="chips">
        {WHITES.filter((w) => w.kelvin >= range.min && w.kelvin <= range.max).map((w) => (
          <button key={w.kelvin} type="button" className="chip" aria-pressed={current?.mode === 'temp' && kelvin === w.kelvin} onClick={() => apply(w.kelvin)}>
            <span className="swatch sm" style={{ '--c': toHex(kelvinToRgb(w.kelvin)) } as CSSProperties} />
            {w.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PaintTab({ target, devices }: { target: string; devices: Device[] }) {
  const { settings } = useSnap();
  const count = Math.max(0, ...devices.map((d) => d.caps.segments));
  const initial = useMemo(() => {
    const source = devices.find((d) => d.caps.segments > 0 && deviceColors(d).length > 0);
    const colors = source ? deviceColors(source) : [0xffffff];
    return colors.length === 1 ? Array<RGB>(count).fill(colors[0]) : resample(colors, count);
    // Only the starting point matters; later device updates must not wipe the painting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);
  const [cells, setCells] = useState<RGB[]>(initial);
  const [brush, setBrush] = useState<RGB>(settings.swatches[0] ?? 0xff5d3d);
  const [custom, setCustom] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const painting = useRef(false);

  if (count === 0) return <p className="muted">These lights are a single colour and cannot be painted segment by segment.</p>;

  const paintAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const index = el?.dataset.cell === undefined ? -1 : Number(el.dataset.cell);
    if (index >= 0) setCells((prev) => (prev[index] === brush ? prev : prev.map((c, i) => (i === index ? brush : c))));
  };

  const distinct = new Set(cells).size;
  const mixed = new Set(devices.filter((d) => d.caps.segments > 0).map((d) => d.caps.segments)).size > 1;

  const saveLook = async () => {
    if (!name.trim()) return toast('Give the look a name first', 'error');
    const colors = [...new Set(cells)].slice(0, 8);
    if (await attempt(api('POST', '/looks', { name: name.trim(), colors, pattern: 'custom', segments: cells, brightness: null }))) {
      toast(`Saved “${name.trim()}”`);
      setNaming(false);
      setName('');
    }
  };

  return (
    <div className="stack">
      <p className="muted small">Pick a colour, then tap or drag across the segments.{mixed && ' The design is stretched to fit lights with a different number of segments.'}</p>
      <div
        className="paint-strip"
        style={{ '--n': count } as CSSProperties}
        onPointerDown={(e) => {
          painting.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          paintAt(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => painting.current && paintAt(e.clientX, e.clientY)}
        onPointerUp={() => (painting.current = false)}
        onPointerCancel={() => (painting.current = false)}
      >
        {cells.map((c, i) => (
          <i key={i} data-cell={i} style={{ '--c': toHex(c) } as CSSProperties} />
        ))}
      </div>

      <div className="swatches" role="group" aria-label="Brush colour">
        {[...new Set([...settings.swatches, 0xffffff])].map((c) => (
          <button key={c} type="button" className="swatch lg" aria-pressed={brush === c} aria-label={`Brush ${toHex(c)}`} style={{ '--c': toHex(c) } as CSSProperties} onClick={() => setBrush(c)}>
            {brush === c && <CheckIcon size={16} />}
          </button>
        ))}
        <button type="button" className="btn ghost sm" aria-expanded={custom} onClick={() => setCustom(!custom)}>
          {custom ? 'Hide picker' : 'Other colour'}
        </button>
      </div>
      {custom && <ColorPad value={brush} onChange={setBrush} onCommit={setBrush} />}

      <div className="inline wrap">
        <button type="button" className="btn" onClick={() => setCells(Array<RGB>(count).fill(brush))}>
          Fill all
        </button>
        <button type="button" className="btn" onClick={() => setNaming(!naming)}>
          Save as look
        </button>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => void control([target], { type: 'segments', colors: cells })}>
          Apply to lights
        </button>
      </div>
      {distinct > 8 && <p className="muted small">{distinct} different colours: each one is a separate message to every light, so this takes a little longer to appear.</p>}
      {naming && (
        <div className="inline">
          <input className="input" autoFocus placeholder="Name this look" aria-label="Look name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void saveLook()} />
          <button type="button" className="btn primary" onClick={() => void saveLook()}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}
