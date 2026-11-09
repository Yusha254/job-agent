'use client';

import { FormEvent, useState } from 'react';
import { BadgeCheck, Check, CircleAlert, ExternalLink, Plus, Trash2, Upload, UserRound, X } from 'lucide-react';

type Fact = { id: string; text: string; section: string; status: 'confirmed' | 'proposed'; source?: string; sourceUrl?: string; evidence?: string };
type Proposal = { id: string; text: string; section?: string; source?: string; sourceUrl?: string; evidence?: string; matches?: Array<{ id: string; reason: string }> };

type Props = {
  profile: Fact[];
  proposedFacts: Proposal[];
  githubUrl: string;
  busy: string;
  onGithubUrlChange: (value: string) => void;
  onImportCV: (file: File) => void;
  onImportGithub: (url: string) => void;
  onAddFact: (text: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onKeep: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (fact: Fact) => void;
};

export function ProfileFactsPanel(props: Props) {
  const [showForm, setShowForm] = useState(false);
  const [text, setText] = useState('');
  const knownFacts = [...props.profile, ...props.proposedFacts];

  function submitFact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onAddFact(text);
    setText('');
    setShowForm(false);
  }

  function submitGithub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    props.onImportGithub(props.githubUrl);
  }

  return (
    <section className="workflow-section profile-section" id="profile">
      <div className="section-title">
        <div><div className="eyebrow">YOUR SOURCE OF TRUTH</div><h2>Profile facts</h2></div>
        <button className="secondary-button" onClick={() => setShowForm((value) => !value)}><Plus size={15} /> Add fact</button>
      </div>
      <p className="section-subtitle">Only confirmed facts can support a score or draft. New facts stay proposed until you approve them.</p>
      <div className="profile-imports">
        <label className="secondary-button upload-button"><Upload size={15} />{props.busy === 'cv-import' ? 'Reading CV…' : 'Import CV'}
          <input type="file" accept=".pdf,.docx,.txt,.md,.rtf,.png,.jpg,.jpeg,.webp" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) props.onImportCV(file);
            event.target.value = '';
          }} disabled={Boolean(props.busy)} />
        </label>
        <form onSubmit={submitGithub}>
          <input type="url" value={props.githubUrl} onChange={(event) => props.onGithubUrlChange(event.target.value)} placeholder="https://github.com/username" aria-label="GitHub profile URL" />
          <button className="secondary-button" disabled={Boolean(props.busy)}><ExternalLink size={15} />{props.busy === 'github-import' ? 'Reading…' : 'Import GitHub'}</button>
        </form>
      </div>
      {showForm && <form className="profile-add" onSubmit={submitFact}><input value={text} onChange={(event) => setText(event.target.value)} placeholder="Add a factual line about your experience" required /><button className="primary-button" disabled={Boolean(props.busy)}>Save as proposed</button></form>}
      <div className="profile-list">
        {props.profile.map((fact) => <div className="profile-line" key={fact.id}>
          <span className="profile-id">{fact.id}</span>
          <span className="profile-text"><strong>{fact.section}{fact.source ? ` · ${fact.source}` : ''}</strong>{fact.text}{fact.evidence && <small>Evidence: {fact.evidence}</small>}</span>
          <div className="fact-actions">
            <button className={`fact-status ${fact.status}`} onClick={() => props.onToggleStatus(fact)}>{fact.status === 'confirmed' ? <><BadgeCheck size={14} />Confirmed</> : <><CircleAlert size={14} />Proposed</>}</button>
            <button className="fact-icon-action reject" onClick={() => props.onDelete(fact.id)} aria-label="Remove fact" title="Remove fact"><Trash2 size={15} /></button>
          </div>
        </div>)}
        {props.proposedFacts.map((fact) => <div className={`profile-line pending-fact ${fact.matches?.length ? 'has-duplicates' : ''}`} key={fact.id}>
          <span className="profile-id">NEW</span>
          <span className="profile-text">
            <strong>{fact.section || 'Profile update'}{fact.source ? ` · ${fact.source}` : ''}</strong>{fact.text}
            {fact.evidence && <small>Evidence: {fact.evidence}</small>}
            {fact.matches?.map((match) => {
              const existing = knownFacts.find((item) => item.id === match.id);
              return <small className="duplicate-note" key={match.id}>Possibly repeats {existing?.section ? `${existing.section}: ` : ''}{existing?.text ?? match.id}. {match.reason}</small>;
            })}
          </span>
          <div className="fact-actions proposal-actions">
            {fact.matches?.length ? <button className="fact-status keep" onClick={() => props.onKeep(fact.id)}><Check size={14} />Keep separate</button> : null}
            <button className="fact-status proposed" onClick={() => props.onApprove(fact.id)}><Check size={14} />Approve</button>
            <button className="fact-icon-action reject" onClick={() => props.onReject(fact.id)} aria-label="Reject fact" title="Reject fact"><X size={15} /></button>
          </div>
        </div>)}
        {!props.profile.length && !props.proposedFacts.length && <div className="profile-empty"><UserRound size={19} /><span>Your profile is empty. Import a CV or add facts before assessing a role.</span></div>}
      </div>
    </section>
  );
}
