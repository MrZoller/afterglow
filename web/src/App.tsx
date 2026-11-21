import { useCallback, useEffect, useState } from 'react';
import type { Look } from '../../shared/types';
import { Toasts } from './components/ui';
import { BulbIcon, ClockIcon, GearIcon, HelpIcon, PaletteIcon } from './icons';
import { login, start, useApp } from './store';
import { HelpView } from './views/Help';
import { LightsView } from './views/Lights';
import { LookEditor, LooksView } from './views/Looks';
import { ControlPanel } from './views/Panel';
import { SchedulesView } from './views/Schedules';
import { SettingsView, ZoneEditor } from './views/Settings';

type Tab = 'lights' | 'looks' | 'schedules' | 'settings' | 'help';

const TABS: { id: Tab; label: string; icon: typeof BulbIcon }[] = [
  { id: 'lights', label: 'Lights', icon: BulbIcon },
  { id: 'looks', label: 'Looks', icon: PaletteIcon },
  { id: 'schedules', label: 'Schedules', icon: ClockIcon },
  { id: 'settings', label: 'Settings', icon: GearIcon },
  { id: 'help', label: 'Help', icon: HelpIcon },
];

const tabFromHash = (): Tab => TABS.find((t) => `#/${t.id}` === window.location.hash)?.id ?? 'lights';

function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return [tab, (t) => (window.location.hash = `#/${t}`)];
}

function Login() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="login"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(await login(token));
      }}
    >
      <img src="/icon.svg" alt="" width="72" height="72" />
      <h1>Afterglow</h1>
      <label className="field">
        <span className="field-label">Passphrase</span>
        <input className="input" type="password" autoFocus autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      {error && <p className="error-text">{error}</p>}
      <button type="submit" className="btn primary">
        Unlock
      </button>
    </form>
  );
}

export function App() {
  const session = useApp((s) => s.session);
  const snap = useApp((s) => s.snap);
  const live = useApp((s) => s.live);
  const [tab, setTab] = useTab();
  const [panel, setPanel] = useState<string | null>(null);
  const [lookEdit, setLookEdit] = useState<{ look: Look | null; tryOn: string; assist?: boolean } | null>(null);
  const [zoneEdit, setZoneEdit] = useState<string | null>(null);

  useEffect(() => void start(), []);
  const closePanel = useCallback(() => setPanel(null), []);

  if (session === 'login') return <Login />;
  if (!snap) {
    return (
      <div className="splash">
        <img src="/icon.svg" alt="" width="72" height="72" />
        <p>Connecting…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="nav" aria-label="Sections">
        <div className="brand">
          <img src="/icon.svg" alt="" width="32" height="32" />
          <span>Afterglow</span>
          {snap.status.mode === 'demo' && <span className="badge">Demo</span>}
        </div>
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
            <t.icon />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      <main className="main">
        {!live && <div className="banner">Reconnecting to Afterglow…</div>}
        {live && !snap.status.connected && snap.devices.length > 0 && <div className="banner error">Can’t reach Govee right now: {snap.status.error ?? 'unknown problem'}</div>}

        {tab === 'lights' && <LightsView open={setPanel} newZone={() => setZoneEdit('new')} />}
        {tab === 'looks' && <LooksView edit={(look, assist) => setLookEdit({ look, tryOn: 'all', assist })} />}
        {tab === 'schedules' && <SchedulesView />}
        {tab === 'settings' && <SettingsView editZone={setZoneEdit} />}
        {tab === 'help' && <HelpView />}
      </main>

      {panel && <ControlPanel target={panel} onClose={closePanel} editLook={(look, tryOn) => setLookEdit({ look, tryOn })} editZone={setZoneEdit} />}
      {lookEdit && <LookEditor look={lookEdit.look} tryOn={lookEdit.tryOn} assist={lookEdit.assist} onClose={() => setLookEdit(null)} />}
      {zoneEdit && <ZoneEditor id={zoneEdit} onClose={() => setZoneEdit(null)} onSaved={setZoneEdit} />}
      <Toasts />
    </div>
  );
}
