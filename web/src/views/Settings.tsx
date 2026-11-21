import { useEffect, useState } from 'react';
import type { Device, Group as Zone } from '../../../shared/types';
import { Field, Group, Sheet, Toggle } from '../components/ui';
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, PencilIcon, PlayIcon, PlusIcon, RefreshIcon, TrashIcon } from '../icons';
import { api, attempt, control, toast, useSnap } from '../store';
import { formatClock, MODEL_NAMES, plural } from '../util';

export function SettingsView({ editZone }: { editZone: (id: string | 'new') => void }) {
  const snap = useSnap();
  const { status, devices, groups, activity } = snap;
  const [scanning, setScanning] = useState(false);

  const rescan = async () => {
    setScanning(true);
    if (await attempt(api('POST', '/rescan'))) toast('Lights rescanned');
    setScanning(false);
  };

  return (
    <>
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <div className="settings">
        <section className="card">
          <h2>Connection</h2>
          {status.mode === 'demo' ? (
            <p>
              <span className="badge">Demo</span> These are simulated lights. To control your own, put your Govee API key in the <code>.env</code> file and restart Afterglow.
            </p>
          ) : status.connected ? (
            <p>
              <span className="badge ok">Connected</span> Talking to your Govee account.
            </p>
          ) : (
            <p className="error-text">Not connected: {status.error ?? 'unknown problem'}</p>
          )}
          <LocalControl />
          <dl className="kv">
            <dt>Requests sent today</dt>
            <dd>
              {status.requestsToday.toLocaleString()}
              {status.dailyRemaining !== null && ` · ${status.dailyRemaining.toLocaleString()} left`}
            </dd>
            <dt>Timezone</dt>
            <dd>{status.timezone}</dd>
            <dt>Version</dt>
            <dd>{status.version}</dd>
          </dl>
          <p className="muted small">Govee limits how many requests an account can send. Each change to a light is one request; a look with several colours is one per colour, per light.</p>
          <button type="button" className="btn" disabled={scanning} onClick={() => void rescan()}>
            <RefreshIcon size={16} /> {scanning ? 'Scanning…' : 'Rescan lights'}
          </button>
        </section>

        <AddressCard />

        <LocationCard />

        <section className="card">
          <h2>Lights</h2>
          <p className="muted small">Rename a light here without changing it in the Govee app. The order sets how lights are listed and which light gets which colour in a “one per light” look. Tick Reversed if designs come out backwards on a light.</p>
          <div className="rows">
            {devices.map((d, i) => (
              <DeviceRow key={d.id} device={d} move={(by) => void attempt(api('PUT', '/order', { ids: moved(devices.map((x) => x.id), i, by) }))} first={i === 0} last={i === devices.length - 1} />
            ))}
          </div>
        </section>

        <section className="card">
          <div className="section-head">
            <h2>Zones</h2>
            <button type="button" className="btn ghost sm" onClick={() => editZone('new')}>
              <PlusIcon size={16} /> New zone
            </button>
          </div>
          {groups.length === 0 ? (
            <p className="muted">No zones yet.</p>
          ) : (
            <div className="rows">
              {groups.map((g) => (
                <button key={g.id} type="button" className="row-btn" onClick={() => editZone(g.id)}>
                  <span>{g.name}</span>
                  <small>{plural(g.deviceIds.filter((id) => devices.some((d) => d.id === id)).length, 'light')}</small>
                  <PencilIcon size={16} />
                </button>
              ))}
            </div>
          )}
        </section>

        <AgentCard authRequired={status.authRequired} />

        <section className="card">
          <h2>Recent activity</h2>
          {activity.length === 0 ? (
            <p className="muted">Nothing yet.</p>
          ) : (
            <ul className="activity">
              {activity.slice(0, 30).map((a) => (
                <li key={a.id} className={a.ok ? '' : 'failed'}>
                  <time>{new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
                  <span className={`badge by-${a.source}`}>{a.source === 'app' ? 'You' : a.source === 'schedule' ? 'Schedule' : 'Agent'}</span>
                  <span>
                    {a.text}
                    {a.detail && <small> · {a.detail}</small>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/** Says how many lights can be driven straight over the home network, and how to add the rest. */
function LocalControl() {
  const { status, devices } = useSnap();
  const near = devices.filter((d) => d.local).length;
  if (!status.lan.enabled) return <p className="muted small">Local control is switched off, so everything goes through Govee’s cloud.</p>;
  if (status.lan.error) return <p className="error-text">Local control is unavailable: {status.lan.error}. Everything goes through Govee’s cloud.</p>;
  if (devices.length === 0) return null;
  return (
    <p>
      <span className={`badge${near ? ' ok' : ''}`}>Local</span>{' '}
      {near === devices.length ? `All ${near} lights answer` : near === 0 ? 'No lights answer' : `${near} of ${devices.length} lights answer`} on your own network.
      {near > 0 && ' On/off, brightness, single colours and white go straight to them, instantly and without using Govee requests. Multi-colour designs and Govee scenes still go through the cloud.'}
      {near < devices.length && ` To add ${near === 0 ? 'them' : 'the rest'}, open each light’s settings in the Govee Home app and turn on LAN Control; they appear here within a minute.`}
    </p>
  );
}

const copyText = (text: string) =>
  navigator.clipboard?.writeText(text).then(
    () => toast('Copied'),
    () => toast('Could not copy; select the text instead', 'error'),
  ) ?? toast('Could not copy; select the text instead', 'error');

/** The addresses to type on another device, including the Tailscale one when this computer is on a tailnet. */
function AddressCard() {
  const { status } = useSnap();
  const others = status.addresses.filter((a) => a.kind !== 'computer');
  const tailscale = others.some((a) => a.kind === 'tailscale');
  return (
    <section className="card">
      <h2>Open on another device</h2>
      {others.length === 0 ? (
        <p className="muted">This computer is not on a network other devices can reach.</p>
      ) : (
        <div className="rows">
          {others.map((a) => (
            <Group key={a.url} label={a.label}>
              <div className="copy-row">
                <code>{a.url}</code>
                <button type="button" className="icon-btn" aria-label={`Copy ${a.url}`} onClick={() => void copyText(a.url)}>
                  <CopyIcon size={16} />
                </button>
              </div>
            </Group>
          ))}
        </div>
      )}
      <p className="muted small">
        {tailscale
          ? 'The Tailscale address works from anywhere, on any device signed in to your tailnet. On a phone, add the page to your home screen to open it like an app.'
          : 'These work on your home network. To reach Afterglow from anywhere, install Tailscale on this computer and your phone; its address will then appear here.'}
      </p>
    </section>
  );
}

function LocationCard() {
  const { settings, status } = useSnap();
  const [lat, setLat] = useState(settings.location ? String(settings.location.lat) : '');
  const [lon, setLon] = useState(settings.location ? String(settings.location.lon) : '');
  const [label, setLabel] = useState(settings.location?.label ?? '');

  const save = async (next?: { lat: number; lon: number }) => {
    const value = next ?? { lat: Number(lat), lon: Number(lon) };
    if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon) || (!next && (!lat.trim() || !lon.trim()))) return toast('Enter a latitude and longitude, e.g. 39.74 and -104.99', 'error');
    if (await attempt(api('PUT', '/settings', { location: { ...value, label: label.trim() } }))) toast('Location saved');
  };

  const locate = () => {
    if (!navigator.geolocation || !window.isSecureContext) return toast('Browsers only share location with secure (https or localhost) pages. Enter the coordinates instead.', 'error');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = { lat: Number(pos.coords.latitude.toFixed(3)), lon: Number(pos.coords.longitude.toFixed(3)) };
        setLat(String(next.lat));
        setLon(String(next.lon));
        void save(next);
      },
      () => toast('Could not get your location. Enter the coordinates instead.', 'error'),
    );
  };

  return (
    <section className="card">
      <h2>Location</h2>
      <p className="muted small">Used only to work out sunrise and sunset for schedules. It stays on this computer.</p>
      {status.sun && (
        <p>
          Today: sunrise {formatClock(status.sun.sunrise)}, sunset {formatClock(status.sun.sunset)}
        </p>
      )}
      <div className="form-row">
        <Field label="Latitude">
          <input className="input" inputMode="decimal" placeholder="39.74" value={lat} onChange={(e) => setLat(e.target.value)} />
        </Field>
        <Field label="Longitude">
          <input className="input" inputMode="decimal" placeholder="-104.99" value={lon} onChange={(e) => setLon(e.target.value)} />
        </Field>
        <Field label="Label (optional)">
          <input className="input" placeholder="Home" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </div>
      <p className="muted small">Tip: in most map apps, right-click or long-press your home to copy its coordinates.</p>
      <div className="inline wrap">
        <button type="button" className="btn primary" onClick={() => void save()}>
          Save location
        </button>
        <button type="button" className="btn" onClick={locate}>
          Use this device’s location
        </button>
        {settings.location && (
          <button type="button" className="btn ghost" onClick={() => void attempt(api('PUT', '/settings', { location: null }))}>
            Clear
          </button>
        )}
      </div>
    </section>
  );
}

/** A copy of the list with one item moved up (-1) or down (+1). */
function moved<T>(list: T[], index: number, by: -1 | 1): T[] {
  const next = [...list];
  const to = index + by;
  if (to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

function MoveButtons({ name, move, first, last }: { name: string; move: (by: -1 | 1) => void; first: boolean; last: boolean }) {
  return (
    <>
      <button type="button" className="icon-btn sm" aria-label={`Move ${name} up`} disabled={first} onClick={() => move(-1)}>
        <ArrowUpIcon size={16} />
      </button>
      <button type="button" className="icon-btn sm" aria-label={`Move ${name} down`} disabled={last} onClick={() => move(1)}>
        <ArrowDownIcon size={16} />
      </button>
    </>
  );
}

function DeviceRow({ device, move, first, last }: { device: Device; move: (by: -1 | 1) => void; first: boolean; last: boolean }) {
  const [name, setName] = useState(device.name);
  // Shown at once rather than after the server confirms, so the box does not flick back.
  const [reversed, setReversed] = useState(device.reversed);
  useEffect(() => setReversed(device.reversed), [device.reversed]);
  const patch = (change: object) => void attempt(api('PATCH', `/devices/${encodeURIComponent(device.id)}`, change));
  const commit = () => {
    const next = name.trim();
    if (next === device.name) return;
    // An empty name falls back to the name from the Govee app.
    patch({ name: next || null });
    if (!next) setName(device.goveeName);
  };
  return (
    <div className="device-row">
      <div className="order-row">
        <input className="input" aria-label={`Name for ${device.goveeName}`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <MoveButtons name={device.name} move={move} first={first} last={last} />
      </div>
      <div className="order-row">
        <small>
          {MODEL_NAMES[device.kind]} · {device.sku}
          {device.caps.segments > 0 && ` · ${device.caps.segments} segments`} · {device.local ? 'reached locally' : 'reached through the cloud'}
        </small>
        {device.caps.segments > 1 && (
          <label className="check">
            <input
              type="checkbox"
              checked={reversed}
              onChange={(e) => {
                setReversed(e.target.checked);
                patch({ reversed: e.target.checked });
              }}
            />{' '}
            Reversed
          </label>
        )}
      </div>
    </div>
  );
}

function AgentCard({ authRequired }: { authRequired: boolean }) {
  const url = `${window.location.origin}/mcp`;
  const command = `claude mcp add --transport http afterglow ${url}${authRequired ? ' --header "Authorization: Bearer YOUR_PASSPHRASE"' : ''}`;
  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast('Copied'),
      () => toast('Could not copy; select the text instead', 'error'),
    ) ?? toast('Could not copy; select the text instead', 'error');

  return (
    <section className="card">
      <h2>AI agents</h2>
      <p className="muted small">Afterglow has a built-in MCP server, so an assistant such as Claude can see your lights, change them, and manage looks and schedules. Point it at this address:</p>
      <Group label="MCP address">
        <div className="copy-row">
          <code>{url}</code>
          <button type="button" className="icon-btn" aria-label="Copy MCP address" onClick={() => void copy(url)}>
            <CopyIcon size={16} />
          </button>
        </div>
      </Group>
      <Group label="Claude Code">
        <div className="copy-row">
          <code>{command}</code>
          <button type="button" className="icon-btn" aria-label="Copy command" onClick={() => void copy(command)}>
            <CopyIcon size={16} />
          </button>
        </div>
      </Group>
      <p className="muted small">The agent must be able to reach this computer, so it works from machines on your home network. Everything an agent does shows up in Recent activity.</p>
    </section>
  );
}

/** Colours for checking a run: it should start green, pass through blue and end red. */
const TEST_COLORS = [0x00ff00, 0x0000ff, 0xff0000];

export function ZoneEditor({ id, onClose, onSaved }: { id: string | 'new'; onClose: () => void; onSaved: (id: string) => void }) {
  const snap = useSnap();
  const zone: Zone | undefined = id === 'new' ? undefined : snap.groups.find((g) => g.id === id);
  const [name, setName] = useState(zone?.name ?? '');
  const [ids, setIds] = useState<string[]>(() => (zone?.deviceIds ?? []).filter((d) => snap.devices.some((x) => x.id === d)));
  const [joined, setJoined] = useState(!!zone?.joined);
  const [reversed, setReversed] = useState<Record<string, boolean>>(() => Object.fromEntries(snap.devices.map((d) => [d.id, d.reversed])));
  const [tested, setTested] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const light = (deviceId: string) => snap.devices.find((d) => d.id === deviceId);
  const joining = joined && ids.length > 1;

  /** Saves the zone and any changed directions. Resolves to the zone's id, or null if it failed. */
  const save = async (): Promise<string | null> => {
    if (!name.trim()) {
      toast('Give the zone a name first', 'error');
      return null;
    }
    const body = { name: name.trim(), deviceIds: ids, joined: joining };
    const saved = await attempt(zone ? api<Zone>('PUT', `/groups/${zone.id}`, body) : api<Zone>('POST', '/groups', body));
    if (!saved) return null;
    for (const deviceId of ids) {
      if (light(deviceId)?.reversed !== !!reversed[deviceId]) await attempt(api('PATCH', `/devices/${encodeURIComponent(deviceId)}`, { reversed: !!reversed[deviceId] }));
    }
    return saved.id;
  };

  const test = async () => {
    const savedId = await save();
    if (!savedId) return;
    onSaved(savedId); // keep editing the zone that now exists
    await control([`group:${savedId}`], { type: 'palette', colors: TEST_COLORS, pattern: 'gradient', brightness: null });
    setTested(true);
  };

  return (
    <Sheet
      title={zone ? 'Edit zone' : 'New zone'}
      onClose={onClose}
      footer={
        <>
          {zone &&
            (confirmDelete ? (
              <button
                type="button"
                className="btn danger"
                onClick={async () => {
                  if (await attempt(api('DELETE', `/groups/${zone.id}`))) onClose();
                }}
              >
                Really delete
              </button>
            ) : (
              <button type="button" className="icon-btn danger" aria-label="Delete zone" onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={18} />
              </button>
            ))}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {tested ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              if (await save()) onClose();
            }}
          >
            Save zone
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Name">
          <input className="input" autoFocus={!zone} value={name} placeholder="e.g. Front yard" maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Group label="Lights in this zone" hint="A light can be in more than one zone.">
          <div className="chips">
            {snap.devices.map((d) => (
              <button key={d.id} type="button" className="chip" aria-pressed={ids.includes(d.id)} onClick={() => setIds(ids.includes(d.id) ? ids.filter((x) => x !== d.id) : [...ids, d.id])}>
                {d.name}
                <small>{MODEL_NAMES[d.kind]}</small>
              </button>
            ))}
          </div>
        </Group>

        {ids.length > 1 && (
          <Group label="Joined end to end" hint={joining ? undefined : 'Turn this on when these lights are mounted one after another, like two ropes along the same path.'}>
            <div className="inline">
              <Toggle on={joined} label="These lights are joined end to end" onChange={setJoined} />
              <span className="muted">{joined ? 'Looks, painting and movement run across them as one long light' : 'Each light shows designs on its own'}</span>
            </div>
          </Group>
        )}

        {joining && (
          <Group label="Order and direction" hint="List the lights from where the run starts to where it ends. To make two runs mirror each other, start both at the same end, such as the street.">
            <div className="rows">
              {ids.map((deviceId, i) => (
                <div key={deviceId} className="order-row boxed">
                  <span className="order-number">{i + 1}</span>
                  <span className="order-name">{light(deviceId)?.name}</span>
                  <label className="check">
                    <input type="checkbox" checked={!!reversed[deviceId]} onChange={(e) => setReversed({ ...reversed, [deviceId]: e.target.checked })} /> Reversed
                  </label>
                  <MoveButtons name={light(deviceId)?.name ?? 'light'} move={(by) => setIds(moved(ids, i, by))} first={i === 0} last={i === ids.length - 1} />
                </div>
              ))}
            </div>
            <div className="inline wrap">
              <button type="button" className="btn" onClick={() => void test()}>
                <PlayIcon size={14} /> Save and test
              </button>
            </div>
            <span className="field-hint">
              {tested
                ? 'The run should now start green, turn blue in the middle and end red. If one light runs the wrong way, tick Reversed for it; if they are in the wrong order, move them. Then test again.'
                : 'The test lights the run green at its start, blue in the middle and red at its end, so you can see whether the order and directions are right.'}
            </span>
          </Group>
        )}
      </div>
    </Sheet>
  );
}
