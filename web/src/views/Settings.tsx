import { useState } from 'react';
import type { Device, Group as Zone } from '../../../shared/types';
import { Field, Group, Sheet } from '../components/ui';
import { CopyIcon, PencilIcon, PlusIcon, RefreshIcon, TrashIcon } from '../icons';
import { api, attempt, toast, useSnap } from '../store';
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
          <p className="muted small">Rename a light here without changing it in the Govee app.</p>
          <div className="rows">
            {devices.map((d) => (
              <DeviceRow key={d.id} device={d} />
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
                  <span className={`badge ${a.source}`}>{a.source === 'app' ? 'You' : a.source === 'schedule' ? 'Schedule' : 'Agent'}</span>
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

function DeviceRow({ device }: { device: Device }) {
  const [name, setName] = useState(device.name);
  const commit = () => {
    const next = name.trim();
    if (next === device.name) return;
    // An empty name falls back to the name from the Govee app.
    void attempt(api('PATCH', `/devices/${encodeURIComponent(device.id)}`, { name: next || null }));
    if (!next) setName(device.goveeName);
  };
  return (
    <div className="device-row">
      <input className="input" aria-label={`Name for ${device.goveeName}`} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      <small>
        {MODEL_NAMES[device.kind]} · {device.sku}
        {device.caps.segments > 0 && ` · ${device.caps.segments} segments`} · {device.local ? 'reached locally' : 'reached through the cloud'}
      </small>
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

export function ZoneEditor({ id, onClose }: { id: string | 'new'; onClose: () => void }) {
  const snap = useSnap();
  const zone: Zone | undefined = id === 'new' ? undefined : snap.groups.find((g) => g.id === id);
  const [name, setName] = useState(zone?.name ?? '');
  const [ids, setIds] = useState<string[]>(zone?.deviceIds ?? []);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    if (!name.trim()) return toast('Give the zone a name first', 'error');
    const body = { name: name.trim(), deviceIds: ids };
    if (await attempt(zone ? api('PUT', `/groups/${zone.id}`, body) : api('POST', '/groups', body))) onClose();
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
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void save()}>
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
      </div>
    </Sheet>
  );
}
