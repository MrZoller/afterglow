import { resample } from '../../../shared/color';
import type { Device, DeviceKind, RGB } from '../../../shared/types';
import { Strip } from '../components/Strip';
import { Empty, Slider, Toggle } from '../components/ui';
import { AlertIcon, PlusIcon, PowerIcon, SunsetIcon } from '../icons';
import { control, useSnap } from '../store';
import { describeAppearance, deviceColors, formatClock, MODEL_NAMES, plural } from '../util';

/** What a card showing several lights should draw: a few colours from each light that is on. */
function composite(devices: Device[]): { colors: RGB[]; scene: boolean } {
  const lit = devices.filter((d) => d.state.power);
  const colors = lit.flatMap((d) => {
    const own = deviceColors(d);
    return own.length > 3 ? resample(own, 3) : own;
  });
  return { colors, scene: colors.length === 0 && lit.some((d) => d.state.appearance.mode === 'scene') };
}

function averageBrightness(devices: Device[]): number {
  const lit = devices.filter((d) => d.state.power && d.state.brightness !== null);
  const pool = lit.length ? lit : devices.filter((d) => d.state.brightness !== null);
  if (pool.length === 0) return 100;
  return Math.round(pool.reduce((sum, d) => sum + (d.state.brightness ?? 0), 0) / pool.length);
}

function TargetCard({
  target,
  title,
  subtitle,
  devices,
  kind,
  hero,
  onOpen,
}: {
  target: string;
  title: string;
  subtitle: React.ReactNode;
  devices: Device[];
  kind?: DeviceKind;
  hero?: boolean;
  onOpen: () => void;
}) {
  const on = devices.some((d) => d.state.power);
  const { colors, scene } = composite(devices);
  const pending = devices.some((d) => d.pending > 0);
  const empty = devices.length === 0;

  return (
    <article className={`card light${hero ? ' hero' : ''}${on ? ' on' : ''}`} onClick={onOpen}>
      <Strip colors={colors} on={on} scene={scene} kind={kind ?? 'rope'} size={hero ? 'lg' : 'md'} />
      <div className="light-head">
        <div className="light-name">
          <h3>
            <button type="button" className="link-btn" onClick={onOpen}>
              {title}
            </button>
          </h3>
          <p className="sub">{pending ? <span className="sending">Sending…</span> : subtitle}</p>
        </div>
        <Toggle on={on} disabled={empty} label={`${title} power`} onChange={(next) => void control([target], { type: 'power', on: next })} />
      </div>
      <Slider
        label={`${title} brightness`}
        value={averageBrightness(devices)}
        disabled={empty || !on}
        onCommit={(value) => void control([target], { type: 'brightness', value })}
      />
    </article>
  );
}

export function LightsView({ open, newZone }: { open: (target: string) => void; newZone: () => void }) {
  const snap = useSnap();
  const { devices, groups, looks, status } = snap;
  const onCount = devices.filter((d) => d.state.power).length;

  if (devices.length === 0) {
    return (
      <>
        <header className="page-head">
          <h1>Lights</h1>
        </header>
        <Empty title={status.connected ? 'No lights found' : 'Not connected to Govee'}>
          <p>{status.connected ? 'Your Govee account has no lights this app can control yet. Add them in the Govee app, then rescan in Settings.' : (status.error ?? 'Check the API key in your .env file.')}</p>
        </Empty>
      </>
    );
  }

  return (
    <>
      <header className="page-head">
        <h1>Lights</h1>
        {status.sun && (
          <span className="pill" title="Today's sunset">
            <SunsetIcon size={16} /> <span className="wide-only">Sunset</span> {formatClock(status.sun.sunset)}
          </span>
        )}
        <button type="button" className="btn" onClick={() => void control(['all'], { type: 'power', on: onCount === 0 })}>
          <PowerIcon size={18} /> {onCount === 0 ? 'All on' : 'All off'}
        </button>
      </header>

      <TargetCard
        hero
        target="all"
        title="All lights"
        subtitle={onCount === 0 ? 'Everything is off' : `${onCount} of ${devices.length} on`}
        devices={devices}
        onOpen={() => open('all')}
      />

      <section>
        <div className="section-head">
          <h2>Zones</h2>
          <button type="button" className="btn ghost sm" onClick={newZone}>
            <PlusIcon size={16} /> New zone
          </button>
        </div>
        {groups.length === 0 ? (
          <p className="muted">Group lights that belong together, like “Front yard”, to control them with one tap.</p>
        ) : (
          <div className="grid">
            {groups.map((g) => {
              const members = devices.filter((d) => g.deviceIds.includes(d.id));
              const lit = members.filter((d) => d.state.power).length;
              return (
                <TargetCard
                  key={g.id}
                  target={`group:${g.id}`}
                  title={g.name}
                  subtitle={members.length === 0 ? 'No lights in this zone' : lit === 0 ? `${plural(members.length, 'light')} · off` : `${lit} of ${members.length} on`}
                  devices={members}
                  onOpen={() => open(`group:${g.id}`)}
                />
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>Lights</h2>
        </div>
        <div className="grid">
          {devices.map((d) => (
            <TargetCard
              key={d.id}
              target={d.id}
              title={d.name}
              kind={d.kind}
              devices={[d]}
              subtitle={
                d.error ? (
                  <span className="error-text">
                    <AlertIcon size={14} /> {d.error}
                  </span>
                ) : (
                  `${MODEL_NAMES[d.kind]} · ${describeAppearance(d, looks)}`
                )
              }
              onOpen={() => open(d.id)}
            />
          ))}
        </div>
      </section>
    </>
  );
}
