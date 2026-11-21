import { useEffect, useState } from 'react';
import { kelvinToRgb, toHex } from '../../../shared/color';
import type { Action, SceneChoice, Schedule, ScheduleView, Status, TimeSpec } from '../../../shared/types';
import { ColorPad } from '../components/ColorPad';
import { TargetPicker } from '../components/TargetPicker';
import { Empty, Field, Group, Segmented, Sheet, Slider, Toggle } from '../components/ui';
import { AlertIcon, CheckIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from '../icons';
import { api, attempt, toast, useSnap } from '../store';
import { describeAction, describeDays, describeNext, describeSeason, describeTargets, describeTime, describeWhen, formatClock } from '../util';

type Input = Omit<Schedule, 'id' | 'lastStart' | 'lastEnd'>;

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const OFFSETS = [-120, -90, -60, -45, -30, -15, 0, 15, 30, 45, 60, 90, 120];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function SchedulesView() {
  const snap = useSnap();
  const [editing, setEditing] = useState<ScheduleView | 'new' | null>(null);

  return (
    <>
      <header className="page-head">
        <h1>Schedules</h1>
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          <PlusIcon size={18} /> New schedule
        </button>
      </header>
      {!snap.settings.location && <p className="notice">Add your location in Settings to schedule by sunrise and sunset.</p>}

      {snap.schedules.length === 0 ? (
        <Empty title="No schedules yet">
          <p>For example: every evening from sunset until 11 PM, show “Warm welcome” on all lights.</p>
        </Empty>
      ) : (
        <div className="list">
          {snap.schedules.map((s) => {
            const season = describeSeason(s.season);
            return (
              <article key={s.id} className={`card schedule${s.enabled ? '' : ' paused'}`}>
                <Toggle on={s.enabled} label={`${s.name} enabled`} onChange={(enabled) => void attempt(api('PATCH', `/schedules/${s.id}`, { enabled }))} />
                <div className="schedule-body">
                  <h3>{s.name}</h3>
                  <p className="schedule-when">
                    {describeTime(s.start)}
                    {s.end && <> → {describeTime(s.end)}</>}
                  </p>
                  <p className="sub">
                    {describeDays(s.days)}
                    {season && ` · ${season}`} · {describeTargets(s.targets, snap)} · {describeAction(s.action, snap)}
                  </p>
                  {s.problem ? (
                    <p className="error-text">
                      <AlertIcon size={14} /> {s.problem}
                    </p>
                  ) : (
                    <p className="next">{s.enabled ? (describeNext(s.next) ?? 'Not due to run') : 'Paused'}</p>
                  )}
                  {s.checkingOff ? (
                    <p className="verify">Checking that the lights turned off…</p>
                  ) : s.lastOff ? (
                    <p className={s.lastOff.ok ? 'verify ok' : 'error-text'}>
                      {s.lastOff.ok ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                      <span>
                        Turn-off {describeWhen(s.lastOff.at)}: {s.lastOff.text[0].toLowerCase() + s.lastOff.text.slice(1)}
                      </span>
                    </p>
                  ) : null}
                </div>
                <div className="schedule-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Run ${s.name} now`}
                    title="Run now"
                    onClick={async () => {
                      if (await attempt(api('POST', `/schedules/${s.id}/run`))) toast(`Ran “${s.name}”`);
                    }}
                  >
                    <PlayIcon size={16} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                    <PencilIcon size={18} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {editing && <ScheduleEditor schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function todayAt(spec: TimeSpec, status: Status): string | null {
  if (spec.type !== 'sun' || !status.sun) return null;
  return `Today that is ${formatClock(status.sun[spec.event] + spec.offsetMin * 60_000)}`;
}

function TimeEditor({ value, onChange, label }: { value: TimeSpec; onChange: (spec: TimeSpec) => void; label: string }) {
  const { status, settings } = useSnap();
  const mode = value.type === 'clock' ? 'clock' : value.event;
  const setMode = (m: 'sunset' | 'sunrise' | 'clock') => onChange(m === 'clock' ? { type: 'clock', time: m === mode ? (value as { time: string }).time : '19:00' } : { type: 'sun', event: m, offsetMin: value.type === 'sun' ? value.offsetMin : 0 });

  return (
    <div className="time-editor">
      <Segmented
        label={label}
        value={mode}
        onChange={setMode}
        options={[
          { id: 'sunset', label: 'Sunset' },
          { id: 'sunrise', label: 'Sunrise' },
          { id: 'clock', label: 'Set time' },
        ]}
      />
      {value.type === 'clock' ? (
        <input className="input" type="time" aria-label={`${label} time`} value={value.time} onChange={(e) => e.target.value && onChange({ type: 'clock', time: e.target.value })} />
      ) : (
        <>
          <select className="input" aria-label={`${label} offset`} value={value.offsetMin} onChange={(e) => onChange({ ...value, offsetMin: Number(e.target.value) })}>
            {OFFSETS.map((o) => (
              <option key={o} value={o}>
                {o === 0 ? `At ${value.event}` : `${Math.abs(o)} min ${o < 0 ? 'before' : 'after'} ${value.event}`}
              </option>
            ))}
          </select>
          <span className="field-hint">{settings.location ? todayAt(value, status) : 'Needs your location, set in Settings.'}</span>
        </>
      )}
    </div>
  );
}

function MonthDay({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [month, day] = value.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const daysIn = new Date(2024, month, 0).getDate(); // leap year so Feb 29 is offered
  return (
    <span className="month-day">
      <select className="input" aria-label={`${label} month`} value={month} onChange={(e) => onChange(`${pad(Number(e.target.value))}-${pad(Math.min(day, new Date(2024, Number(e.target.value), 0).getDate()))}`)}>
        {MONTHS.map((m, i) => (
          <option key={m} value={i + 1}>
            {m}
          </option>
        ))}
      </select>
      <select className="input" aria-label={`${label} day`} value={day} onChange={(e) => onChange(`${pad(month)}-${pad(Number(e.target.value))}`)}>
        {Array.from({ length: daysIn }, (_, i) => (
          <option key={i} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </select>
    </span>
  );
}

type ActionKind = 'on' | 'look' | 'scene' | 'color' | 'white' | 'off';

const kindOf = (a: Action): ActionKind => (a.type === 'look' ? 'look' : a.type === 'scene' ? 'scene' : a.type === 'color' ? 'color' : a.type === 'colorTemp' ? 'white' : a.type === 'power' && !a.on ? 'off' : 'on');

function ScheduleEditor({ schedule, onClose }: { schedule: ScheduleView | null; onClose: () => void }) {
  const snap = useSnap();
  const [draft, setDraft] = useState<Input>(() =>
    schedule
      ? { name: schedule.name, enabled: schedule.enabled, days: schedule.days, start: schedule.start, end: schedule.end, season: schedule.season, targets: schedule.targets, action: schedule.action }
      : {
          name: '',
          enabled: true,
          days: [0, 1, 2, 3, 4, 5, 6],
          start: snap.settings.location ? { type: 'sun', event: 'sunset', offsetMin: 0 } : { type: 'clock', time: '18:00' },
          end: { type: 'clock', time: '23:00' },
          season: null,
          targets: ['all'],
          action: snap.looks[0] ? { type: 'look', lookId: snap.looks[0].id } : { type: 'power', on: true },
        },
  );
  const [scenes, setScenes] = useState<SceneChoice[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<Input>) => setDraft((d) => ({ ...d, ...patch }));
  const kind = kindOf(draft.action);
  const targetKey = draft.targets.join(',');

  useEffect(() => {
    if (kind !== 'scene' || !targetKey) return;
    let stale = false;
    setScenes(null);
    api<{ scenes: SceneChoice[] }>('GET', `/scenes?targets=${encodeURIComponent(targetKey)}`).then(
      (r) => !stale && setScenes(r.scenes),
      () => !stale && setScenes([]),
    );
    return () => {
      stale = true;
    };
  }, [kind, targetKey]);

  const setKind = (k: ActionKind) => {
    const actions: Record<ActionKind, Action> = {
      on: { type: 'power', on: true },
      off: { type: 'power', on: false },
      look: { type: 'look', lookId: snap.looks[0]?.id ?? '' },
      scene: { type: 'scene', scene: { kind: 'light', name: '' } },
      color: { type: 'color', rgb: 0xffb057 },
      white: { type: 'colorTemp', kelvin: 2700 },
    };
    update({ action: actions[k], ...(k === 'off' ? { end: null } : {}) });
  };

  const save = async () => {
    if (!draft.name.trim()) return toast('Give the schedule a name first', 'error');
    if (draft.targets.length === 0) return toast('Choose which lights this schedule controls', 'error');
    if (draft.action.type === 'scene' && !draft.action.scene.name) return toast('Choose a scene', 'error');
    if (draft.action.type === 'look' && !draft.action.lookId) return toast('Choose a look', 'error');
    setBusy(true);
    const saved = await attempt(schedule ? api('PUT', `/schedules/${schedule.id}`, draft) : api('POST', '/schedules', draft));
    setBusy(false);
    if (saved) onClose();
  };

  return (
    <Sheet
      title={schedule ? 'Edit schedule' : 'New schedule'}
      onClose={onClose}
      footer={
        <>
          {schedule &&
            (confirmDelete ? (
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  if (await attempt(api('DELETE', `/schedules/${schedule.id}`))) onClose();
                }}
              >
                Really delete
              </button>
            ) : (
              <button type="button" className="icon-btn danger" aria-label="Delete schedule" onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={18} />
              </button>
            ))}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            Save schedule
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Name">
          <input className="input" value={draft.name} placeholder="e.g. Evening glow" maxLength={60} onChange={(e) => update({ name: e.target.value })} />
        </Field>

        <Group label="Lights">
          <TargetPicker value={draft.targets} onChange={(targets) => update({ targets })} />
        </Group>

        <Group label="What happens">
          <div className="chips">
            {(
              [
                ['look', 'Show a look'],
                ['scene', 'Govee scene'],
                ['color', 'Colour'],
                ['white', 'White'],
                ['on', 'Just turn on'],
                ['off', 'Turn off'],
              ] as [ActionKind, string][]
            ).map(([k, label]) => (
              <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => kind !== k && setKind(k)}>
                {label}
              </button>
            ))}
          </div>
          {draft.action.type === 'look' &&
            (snap.looks.length ? (
              <select className="input" aria-label="Look" value={draft.action.lookId} onChange={(e) => update({ action: { type: 'look', lookId: e.target.value } })}>
                {snap.looks.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="field-hint">You have no looks yet. Create one on the Looks tab.</span>
            ))}
          {draft.action.type === 'scene' &&
            (scenes === null ? (
              <span className="field-hint">Loading scenes…</span>
            ) : (
              <select
                className="input"
                aria-label="Scene"
                value={draft.action.scene.name ? `${draft.action.scene.kind}:${draft.action.scene.name}` : ''}
                onChange={(e) => {
                  const picked = scenes.find((s) => `${s.kind}:${s.name}` === e.target.value);
                  if (picked) update({ action: { type: 'scene', scene: { kind: picked.kind, name: picked.name } } });
                }}
              >
                <option value="">Choose a scene…</option>
                {scenes.map((s) => (
                  <option key={`${s.kind}:${s.name}`} value={`${s.kind}:${s.name}`}>
                    {s.name}
                    {s.kind === 'diy' ? ' (DIY)' : s.kind === 'snapshot' ? ' (snapshot)' : ''}
                  </option>
                ))}
              </select>
            ))}
          {draft.action.type === 'color' && <ColorPad value={draft.action.rgb} onCommit={(rgb) => update({ action: { type: 'color', rgb } })} />}
          {draft.action.type === 'colorTemp' && (
            <Slider
              label="White temperature"
              value={draft.action.kelvin}
              min={2000}
              max={9000}
              step={100}
              format={(v) => `${v}K`}
              track={`linear-gradient(90deg, ${[2000, 3750, 5500, 7250, 9000].map((k) => toHex(kelvinToRgb(k))).join(', ')})`}
              onCommit={(kelvin) => update({ action: { type: 'colorTemp', kelvin } })}
            />
          )}
        </Group>

        <Group label={kind === 'off' ? 'When' : 'Starts'}>
          <TimeEditor label="Start" value={draft.start} onChange={(start) => update({ start })} />
        </Group>

        {kind !== 'off' && (
          <Group label="Turn off again">
            <div className="inline">
              <Toggle on={!!draft.end} label="Turn off again at a set time" onChange={(on) => update({ end: on ? { type: 'clock', time: '23:00' } : null })} />
              <span className="muted">{draft.end ? 'Lights turn off at:' : 'Leave the lights on'}</span>
            </div>
            {draft.end && <TimeEditor label="End" value={draft.end} onChange={(end) => update({ end })} />}
          </Group>
        )}

        <Group label="Days">
          <div className="days">
            {DAY_LETTERS.map((letter, d) => (
              <button
                key={d}
                type="button"
                className="day"
                aria-label={DAY_NAMES[d]}
                aria-pressed={draft.days.includes(d)}
                onClick={() => {
                  const days = draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort();
                  if (days.length) update({ days });
                }}
              >
                {letter}
              </button>
            ))}
          </div>
        </Group>

        <Group label="Time of year" hint={draft.season ? 'Runs between these dates every year. A seasonal schedule wins over an everyday one that starts at the same time.' : undefined}>
          <div className="inline">
            <Toggle on={!!draft.season} label="Only at a certain time of year" onChange={(on) => update({ season: on ? { from: '12-01', to: '01-06' } : null })} />
            <span className="muted">{draft.season ? 'Only between:' : 'All year round'}</span>
          </div>
          {draft.season && (
            <div className="inline wrap">
              <MonthDay label="From" value={draft.season.from} onChange={(from) => update({ season: { ...draft.season!, from } })} />
              <span className="muted">to</span>
              <MonthDay label="To" value={draft.season.to} onChange={(to) => update({ season: { ...draft.season!, to } })} />
            </div>
          )}
        </Group>
      </div>
    </Sheet>
  );
}
