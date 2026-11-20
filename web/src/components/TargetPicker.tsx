import { useSnap } from '../store';
import { MODEL_NAMES } from '../util';

/** Chooses what an action applies to: everything, zones, or individual lights. */
export function TargetPicker({ value, onChange }: { value: string[]; onChange: (targets: string[]) => void }) {
  const snap = useSnap();
  const all = value.includes('all');

  const toggle = (target: string) => {
    if (target === 'all') return onChange(all ? [] : ['all']);
    const rest = value.filter((t) => t !== 'all');
    onChange(rest.includes(target) ? rest.filter((t) => t !== target) : [...rest, target]);
  };

  const chip = (target: string, label: string, hint?: string) => (
    <button key={target} type="button" className="chip" aria-pressed={value.includes(target)} onClick={() => toggle(target)}>
      {label}
      {hint && <small>{hint}</small>}
    </button>
  );

  return (
    <div className="target-picker">
      <div className="chips">
        {chip('all', 'All lights')}
        {snap.groups.map((g) => chip(`group:${g.id}`, g.name, `${g.deviceIds.length}`))}
      </div>
      {!all && <div className="chips">{snap.devices.map((d) => chip(d.id, d.name, MODEL_NAMES[d.kind]))}</div>}
    </div>
  );
}
