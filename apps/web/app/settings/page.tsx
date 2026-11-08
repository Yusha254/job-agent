'use client';

import { FormEvent, useEffect, useState } from 'react';
import { ArrowLeft, LoaderCircle, Save, Settings2 } from 'lucide-react';

type Settings = {
  name: string;
  homeLocation: string;
  githubUrl: string;
  applyThreshold: number;
  skipThreshold: number;
  weights: {
    skills: number;
    'experience/qualifications': number;
    location: number;
    pay: number;
    'growth/mentorship': number;
  };
};

const DEFAULT_SETTINGS: Settings = {
  name: 'Joshua Kyalo', homeLocation: 'Kenya', githubUrl: '', applyThreshold: 65, skipThreshold: 50,
  weights: { skills: 40, 'experience/qualifications': 20, location: 15, pay: 15, 'growth/mentorship': 10 },
};

async function getSettings(): Promise<Settings> {
  const response = await fetch('/api/settings');
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Could not load settings.');
  return body as Settings;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void getSettings().then(setSettings).catch((reason) => setError(reason.message));
  }, []);

  function updateWeight(key: keyof Settings['weights'], value: number) {
    setSettings((current) => ({ ...current, weights: { ...current.weights, [key]: value } }));
    setSaved(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setSaved(false);
    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? 'Could not save settings.');
      setSettings(body as Settings); setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save settings.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="rail">
        <a className="brand" href="/"><div className="brand-mark">f.</div><span>fieldnote</span></a>
        <div className="rail-label">WORKSPACE</div>
        <a className="rail-link" href="/"><ArrowLeft size={17} /><span>Applications</span></a>
        <a className="rail-link active" href="/settings"><Settings2 size={17} /><span>Settings</span></a>
        <div className="rail-bottom"><span className="avatar">{settings.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><div><strong>{settings.name}</strong><small>Personal workspace</small></div></div>
      </aside>
      <section className="main-area">
        <header className="topbar"><div className="crumb"><a href="/">Workspace</a><span>/</span>Settings</div><div className="topbar-right"><span className="local-indicator"><i /> Local workspace</span></div></header>
        <div className="content settings-content">
          <div className="page-heading"><div><div className="eyebrow">WORKSPACE CONFIGURATION</div><h1>Settings</h1><p>Set the profile identity and assessment priorities used by every stage.</p></div></div>
          {error && <div className="error-banner">{error}</div>}
          <form className="settings-form" onSubmit={save}>
            <section className="settings-block">
              <div className="settings-block-heading"><div><span className="eyebrow">PROFILE</span><h2>Who is applying?</h2></div><p>This name is used in the shared prompt and workspace.</p></div>
              <div className="settings-fields"><label>Full name<input value={settings.name} onChange={(event) => { setSettings((current) => ({ ...current, name: event.target.value })); setSaved(false); }} required /></label><label>Home location<input value={settings.homeLocation} onChange={(event) => { setSettings((current) => ({ ...current, homeLocation: event.target.value })); setSaved(false); }} required /></label><label className="wide-field">GitHub profile URL<input type="url" value={settings.githubUrl} onChange={(event) => { setSettings((current) => ({ ...current, githubUrl: event.target.value })); setSaved(false); }} placeholder="https://github.com/username" /></label></div>
            </section>
            <section className="settings-block">
              <div className="settings-block-heading"><div><span className="eyebrow">DECISION RANGE</span><h2>Score thresholds</h2></div><p>Roles between these thresholds wait for your answers.</p></div>
              <div className="settings-fields threshold-fields"><label>Apply at or above<input type="number" min="1" max="100" value={settings.applyThreshold} onChange={(event) => { setSettings((current) => ({ ...current, applyThreshold: Number(event.target.value) })); setSaved(false); }} /></label><label>Skip below<input type="number" min="0" max="99" value={settings.skipThreshold} onChange={(event) => { setSettings((current) => ({ ...current, skipThreshold: Number(event.target.value) })); setSaved(false); }} /></label></div>
            </section>
            <section className="settings-block">
              <div className="settings-block-heading"><div><span className="eyebrow">FIT MODEL</span><h2>Criterion weights</h2></div><p>Weights must add up to 100. Current total: <strong>{Object.values(settings.weights).reduce((sum, value) => sum + Number(value || 0), 0)}</strong></p></div>
              <div className="weight-fields">
                {Object.entries(settings.weights).map(([key, value]) => <label key={key}>{key}<span className="weight-input"><input type="number" min="0" max="100" value={value} onChange={(event) => updateWeight(key as keyof Settings['weights'], Number(event.target.value))} /><small>pts</small></span></label>)}
              </div>
            </section>
            <div className="settings-save-row"><span>{saved ? 'Settings saved.' : 'Changes apply to future assessments and drafts.'}</span><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{busy ? 'Saving…' : 'Save settings'}</button></div>
          </form>
          <footer className="page-footer"><span>FIELDNOTE <i>·</i> YOUR APPLICATION WORKSPACE</span><span>Human judgment stays in the loop.</span></footer>
        </div>
      </section>
    </main>
  );
}
