'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  ArrowDownUp, ArrowRight, BadgeCheck, BriefcaseBusiness, Check, ChevronDown, CircleAlert,
  CircleHelp, ClipboardCheck, FilePlus2, FileText, Filter, Globe2, Inbox, LoaderCircle,
  MapPin, Plus, Search, Send, Settings2, ShieldCheck, Sparkles, UserRound, X,
} from 'lucide-react';
import { ProfileFactsPanel } from './components/ProfileFactsPanel';

type JobStatus = 'NEW' | 'EXTRACTED' | 'FILTERED_OUT' | 'REJECTED' | 'SCORED' | 'AWAITING_ANSWERS' | 'DRAFTED' | 'VERIFIED' | 'AWAITING_APPROVAL' | 'APPROVED' | 'SENT' | 'SKIPPED';
type Job = {
  id: string; createdAt: string; updatedAt: string; sourceUrl: string; applyUrl: string;
  posting: string; status: JobStatus; extraction?: any; score?: any; draft?: any;
  verification?: any; filterReason?: string;
};
type ProfileLine = { id: string; text: string; section: string; status: 'confirmed' | 'proposed'; source?: string; sourceUrl?: string; evidence?: string };
type UserSettings = {
  name: string; homeCity: string; homeCountry: string; githubUrl: string; applyThreshold: number; skipThreshold: number;
  weights: { skills: number; 'experience/qualifications': number; location: number; pay: number; 'growth/mentorship': number };
};
type Dashboard = { settings: UserSettings; jobs: Job[]; profile: ProfileLine[]; questions: any[]; proposedFacts: any[]; counts: Record<string, number> };

const API = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    if (!(init?.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    response = await fetch(`${API}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new Error('The local API could not be reached. Start the workspace with `npm run dev`.');
  }
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json().catch(() => ({})) : {};
  if (!isJson && response.status >= 500) {
    throw new Error('The Nest API is not responding. Start both apps with `npm run dev` from the workspace root.');
  }
  if (!response.ok) throw new Error(payload.message ?? `Request failed (${response.status})`);
  return payload as T;
}

const statusNames: Record<JobStatus, string> = {
  NEW: 'New', EXTRACTED: 'Ready to score', FILTERED_OUT: 'Filtered out', REJECTED: 'Rejected',
  SCORED: 'Ready to draft', AWAITING_ANSWERS: 'Needs your input', DRAFTED: 'Verifier flagged',
  VERIFIED: 'Verified', AWAITING_APPROVAL: 'Ready for review', APPROVED: 'Approved',
  SENT: 'Sent', SKIPPED: 'Skipped',
};

function roleTitle(job: Job) { return job.extraction?.role || job.posting.split('\n').find(Boolean)?.slice(0, 60) || 'Untitled role'; }
function companyName(job: Job) { return job.extraction?.company || 'Company not extracted'; }
function formattedDate(value: string) { return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); }

export default function Home() {
  const [data, setData] = useState<Dashboard>({
    settings: { name: 'Joshua Kyalo', homeCity: '', homeCountry: 'Kenya', githubUrl: '', applyThreshold: 65, skipThreshold: 50, weights: { skills: 40, 'experience/qualifications': 20, location: 15, pay: 15, 'growth/mentorship': 10 } },
    jobs: [], profile: [], questions: [], proposedFacts: [], counts: {},
  });
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('All roles');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [compose, setCompose] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  async function refresh() {
    const result = await request<Dashboard>('/dashboard');
    setData(result);
    setSelectedId((current) => current && result.jobs.some((job) => job.id === current) ? current : result.jobs[0]?.id ?? '');
  }

  useEffect(() => { void refresh().catch((reason) => setError(reason.message)); }, []);

  async function act(key: string, operation: () => Promise<unknown>) {
    setBusy(key); setError('');
    try { await operation(); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Something went wrong.'); }
    finally { setBusy(''); }
  }

  async function createJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await act('create', async () => {
      const file = form.get('file');
      const hasFile = file instanceof File && file.size > 0;
      const job = await request<Job>('/jobs', {
        method: 'POST',
        body: hasFile ? form : JSON.stringify({ posting: form.get('posting'), sourceUrl: form.get('sourceUrl'), applyUrl: form.get('applyUrl') }),
      });
      setSelectedId(job.id); setCompose(false);
    });
  }

  async function batchQuestions() {
    await act('questions', async () => {
      const result = await request<{ questions: any[] }>('/pipeline/questions', { method: 'POST' });
      setData((current) => ({ ...current, questions: result.questions }));
    });
  }

  async function submitAnswers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = data.questions.map((question) => ({ id: question.id, answer: answers[question.id] || 'None' }));
    await act('answers', () => request('/pipeline/answers', { method: 'POST', body: JSON.stringify({ answers: submitted }) }));
    setAnswers({});
  }

  async function addProfile(text: string) {
    await act('profile', () => request('/profile', { method: 'POST', body: JSON.stringify({ text, section: 'Experience' }) }));
  }

  async function importCV(file: File) {
    const form = new FormData();
    form.append('file', file);
    await act('cv-import', () => request('/profile/import', { method: 'POST', body: form }));
  }

  async function importGithub(url: string) {
    await act('github-import', () => request('/profile/github', { method: 'POST', body: JSON.stringify({ url }) }));
  }

  const selected = data.jobs.find((job) => job.id === selectedId);
  const visibleJobs = data.jobs.filter((job) => {
    const term = search.toLowerCase();
    const matchesText = !term || `${companyName(job)} ${roleTitle(job)} ${job.extraction?.location ?? ''}`.toLowerCase().includes(term);
    const matchesFilter = filter === 'All roles' || (filter === 'Needs your input' && job.status === 'AWAITING_ANSWERS') || (filter === 'For review' && ['AWAITING_APPROVAL', 'DRAFTED'].includes(job.status)) || (filter === 'In progress' && ['NEW', 'EXTRACTED', 'SCORED'].includes(job.status)) || (filter === 'Completed' && ['APPROVED', 'SENT', 'SKIPPED', 'FILTERED_OUT', 'REJECTED'].includes(job.status));
    return matchesText && matchesFilter;
  });

  const nextAction = selected?.status === 'NEW' ? { label: 'Extract posting', icon: Sparkles, run: () => act(selected.id, () => request(`/jobs/${selected.id}/extract`, { method: 'POST' })) }
    : selected?.status === 'EXTRACTED' ? { label: 'Audit & score', icon: ArrowRight, run: () => act(selected.id, () => request(`/jobs/${selected.id}/score`, { method: 'POST' })) }
    : selected?.status === 'AWAITING_APPROVAL' ? { label: 'Approve draft', icon: Check, run: () => act(selected.id, () => request(`/jobs/${selected.id}/approve`, { method: 'POST' })) }
    : selected?.status === 'APPROVED' ? { label: 'Mark as sent', icon: Send, run: () => act(selected.id, () => request(`/jobs/${selected.id}/sent`, { method: 'POST' })) }
    : null;

  return (
    <main className="app-shell">
      <aside className="rail">
        <div className="brand"><div className="brand-mark">f.</div><span>fieldnote</span></div>
        <div className="rail-label">WORKSPACE</div>
        <button className="rail-link active"><BriefcaseBusiness size={17} /><span>Applications</span><span className="nav-count">{data.jobs.length}</span></button>
        <button className="rail-link" onClick={() => document.getElementById('profile')?.scrollIntoView({ behavior: 'smooth' })}><UserRound size={17} /><span>Profile</span></button>
        <div className="rail-bottom"><span className="avatar">{data.settings.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><div><strong>{data.settings.name}</strong><small>Personal workspace</small></div><a className="settings-link" href="/settings" aria-label="Settings" title="Settings"><Settings2 size={16} /></a></div>
      </aside>

      <section className="main-area">
        <header className="topbar"><div className="crumb">Workspace <span>/</span> Applications</div><div className="topbar-right"><span className="local-indicator"><i /> Local workspace</span><button className="icon-button" aria-label="Help" title="Help"><CircleHelp size={18} /></button></div></header>
        <div className="content">
          <div className="page-heading"><div><div className="eyebrow">YOUR SEARCH, IN MOTION</div><h1>Applications</h1><p>Keep good opportunities moving, one considered step at a time.</p></div><button className="primary-button" onClick={() => setCompose(true)}><Plus size={17} /> Add a role</button></div>

          <div className="metrics-row">
            <div className="metric"><span>IN THE QUEUE</span><strong>{data.jobs.length.toString().padStart(2, '0')}</strong><small>roles tracked</small></div>
            <div className="metric"><span>NEEDS YOUR INPUT</span><strong className="metric-accent">{data.counts.AWAITING_ANSWERS ?? 0}</strong><small>answers unlock scoring</small></div>
            <div className="metric"><span>READY TO REVIEW</span><strong>{(data.counts.AWAITING_APPROVAL ?? 0) + (data.counts.DRAFTED ?? 0)}</strong><small>drafts in your hands</small></div>
            <div className="week-note"><div className="week-icon"><ClipboardCheck size={19} /></div><div><strong>Thoughtful beats rushed.</strong><span>Your profile facts stay yours to approve.</span></div></div>
          </div>

          {(data.proposedFacts.length > 0 || data.questions.length > 0) && <div className="attention-strip"><CircleAlert size={18} /><span>{data.questions.length ? `${data.questions.length} questions are ready for you.` : `${data.proposedFacts.length} profile updates are waiting for approval.`}</span><button onClick={() => document.getElementById(data.questions.length ? 'questions' : 'profile')?.scrollIntoView({ behavior: 'smooth' })}>Take a look <ArrowRight size={14} /></button></div>}
          {error && <div className="error-banner"><CircleAlert size={16} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={15} /></button></div>}

          <div className="workspace-grid">
            <section className="queue-panel">
              <div className="queue-heading"><div><h2>Role queue</h2><span>{visibleJobs.length} {visibleJobs.length === 1 ? 'role' : 'roles'}</span></div><button className="subtle-icon" title="Sort by recent" aria-label="Sort by recent"><ArrowDownUp size={16} /></button></div>
              <div className="queue-tools"><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search roles" /></label><button className="subtle-icon filter-button" title="Filter roles" aria-label="Filter roles"><Filter size={16} /></button></div>
              <div className="filter-tabs">{['All roles', 'Needs your input', 'For review', 'In progress', 'Completed'].map((item) => <button key={item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div>
              <div className="role-list">
                {visibleJobs.map((job) => <button className={`role-row ${selectedId === job.id ? 'chosen' : ''}`} key={job.id} onClick={() => setSelectedId(job.id)}>
                  <span className="company-mark">{companyName(job).slice(0, 1).toUpperCase()}</span><span className="role-copy"><strong>{roleTitle(job)}</strong><span>{companyName(job)}</span><small>{job.extraction?.location || (job.status === 'NEW' ? 'Awaiting extraction' : 'Location not listed')}</small></span>
                  <span className="role-trailing">{typeof job.score?.score_min === 'number' && <b className="score-chip">{job.score.score_min}<small>+</small></b>}<span className={`status-dot ${job.status.toLowerCase()}`} title={statusNames[job.status]} /></span>
                </button>)}
                {!visibleJobs.length && <div className="empty-queue"><Inbox size={24} /><strong>{data.jobs.length ? 'No roles match this view' : 'Your queue starts here'}</strong><span>{data.jobs.length ? 'Try another filter or search.' : 'Add a posting to begin your first application.'}</span>{!data.jobs.length && <button className="text-button" onClick={() => setCompose(true)}>Add your first role <ArrowRight size={14} /></button>}</div>}
              </div>
              <div className="queue-footer"><ShieldCheck size={15} /><span>Every application stays in your control.</span></div>
            </section>

            <section className="detail-panel">
              {selected ? <>
                <div className="detail-topline"><span className="detail-label">ROLE OVERVIEW</span><button className="more-button"><span>•••</span><ChevronDown size={13} /></button></div>
                <div className="detail-company"><span className="company-mark large">{companyName(selected).slice(0, 1).toUpperCase()}</span><span className={`status-pill ${selected.status.toLowerCase()}`}>{statusNames[selected.status]}</span></div>
                <h2 className="detail-title">{roleTitle(selected)}</h2><div className="company-line">{companyName(selected)} <span>·</span> Added {formattedDate(selected.createdAt)}</div>
                <div className="detail-facts"><span><MapPin size={15} />{selected.extraction?.location || 'Location unknown'}</span><span><Globe2 size={15} />{selected.extraction?.remote === 'yes' ? 'Remote' : selected.extraction?.remote === 'no' ? 'On-site' : 'Remote unclear'}</span><span><FileText size={15} />{selected.extraction?.contract || 'Contract not stated'}</span></div>
                <div className="detail-divider" />
                <div className="section-title"><h3>Pipeline</h3><span>{selected.status === 'SENT' ? 'Complete' : 'Current step'}</span></div>
                <div className="pipeline-steps"><span className={['NEW', 'EXTRACTED', 'SCORED', 'AWAITING_ANSWERS', 'DRAFTED', 'AWAITING_APPROVAL', 'APPROVED', 'SENT'].includes(selected.status) ? 'done' : ''}><i><Check size={11} /></i>Extract</span><span className={['SCORED', 'AWAITING_ANSWERS', 'DRAFTED', 'AWAITING_APPROVAL', 'APPROVED', 'SENT'].includes(selected.status) ? 'done' : ''}><i><Check size={11} /></i>Assess</span><span className={['DRAFTED', 'AWAITING_APPROVAL', 'APPROVED', 'SENT'].includes(selected.status) ? 'done' : ''}><i><Check size={11} /></i>Draft</span><span className={['APPROVED', 'SENT'].includes(selected.status) ? 'done' : ''}><i><Check size={11} /></i>Review</span></div>
                {selected.filterReason && <div className="result-box caution"><CircleAlert size={17} /><span>{selected.filterReason}</span></div>}
                {selected.extraction?.legitimacy?.verdict === 'flag' && <div className="result-box caution"><CircleAlert size={17} /><span>{selected.extraction.legitimacy.reasons.join(' ') || 'Legitimacy requires a closer look.'}</span></div>}
                {selected.score && <div className="score-card"><div><span className="detail-label">FIT RANGE</span><strong>{selected.score.score_min}<small>–</small>{selected.score.score_max}<em>/100</em></strong></div><div className="score-verdict">{selected.score.recommendation === 'apply' ? 'Worth pursuing' : selected.score.recommendation === 'skip' ? 'Below your threshold' : 'A few unknowns remain'}</div><p>{selected.score.digest_summary || selected.score.reasoning}</p></div>}
                {selected.draft && <div className="draft-preview"><div className="section-title"><h3><FileText size={16} /> Draft</h3>{selected.verification?.pass === false ? <span className="flag-label"><CircleAlert size={13} /> Needs attention</span> : <span className="verified-label"><BadgeCheck size={14} /> Verified</span>}</div>
                  {selected.draft.cover_letter?.paragraphs?.map((paragraph: any, index: number) => <p key={index}>{paragraph.text}</p>)}
                  {selected.verification?.issues?.length > 0 && <div className="issues-list">{selected.verification.issues.map((issue: any, index: number) => <div key={index}><CircleAlert size={14} /><span>{issue.problem}: {issue.sentence}</span></div>)}</div>}
                </div>}
                {selected.status === 'AWAITING_ANSWERS' && <div className="result-box info"><CircleHelp size={17} /><span>Answer a shared profile question to resolve unknowns across your queue.</span></div>}
                {selected.status === 'DRAFTED' && <div className="result-box caution"><CircleAlert size={17} /><span>The verifier still found issues after one redraft. Review before taking this further.</span></div>}
                <div className="detail-actions">
                  {nextAction && <button className="primary-button full" onClick={nextAction.run} disabled={Boolean(busy)}>{busy === selected.id ? <LoaderCircle className="spin" size={16} /> : <nextAction.icon size={16} />}{nextAction.label}</button>}
                  {selected.status === 'AWAITING_ANSWERS' && <button className="primary-button full" onClick={batchQuestions} disabled={Boolean(busy)}>{busy === 'questions' ? <LoaderCircle className="spin" size={16} /> : <CircleHelp size={16} />}Build shared question batch</button>}
                  {!['SENT', 'SKIPPED', 'FILTERED_OUT', 'REJECTED', 'APPROVED'].includes(selected.status) && <button className="quiet-action" onClick={() => act(selected.id, () => request(`/jobs/${selected.id}/skip`, { method: 'POST' }))} disabled={Boolean(busy)}>Skip this role</button>}
                  {selected.status === 'APPROVED' && <span className="approval-note">Approved by you. Mark it sent once you have submitted outside this app.</span>}
                </div>
              </> : <div className="detail-empty"><div className="detail-empty-mark"><BriefcaseBusiness size={23} /></div><h2>Choose a role to begin</h2><p>Its extracted details, fit assessment and next step will appear here.</p><button className="text-button" onClick={() => setCompose(true)}>Add a role <ArrowRight size={14} /></button></div>}
            </section>
          </div>

          {data.questions.length > 0 && <section className="workflow-section" id="questions"><div className="section-title"><div><div className="eyebrow">PROFILE, ONCE</div><h2>Quick answers</h2></div><span>{data.questions.length} questions · shared across roles</span></div><form onSubmit={submitAnswers} className="question-grid">{data.questions.map((question) => <label className="question-item" key={question.id}><span>{question.text}</span><small>{question.answer_format || 'One-line answer; None is okay'}</small><input value={answers[question.id] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} placeholder="Your answer or None" /></label>)}<button className="primary-button" disabled={Boolean(busy)}>{busy === 'answers' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save answers for review</button></form></section>}

          <ProfileFactsPanel
            profile={data.profile}
            proposedFacts={data.proposedFacts}
            githubUrl={data.settings.githubUrl}
            busy={busy}
            onGithubUrlChange={(githubUrl) => setData((current) => ({ ...current, settings: { ...current.settings, githubUrl } }))}
            onImportCV={(file) => void importCV(file)}
            onImportGithub={(githubUrl) => void importGithub(githubUrl)}
            onAddFact={(text) => void addProfile(text)}
            onApprove={(id) => void act(`approve-${id}`, () => request('/profile/approve', { method: 'POST', body: JSON.stringify({ ids: [id] }) }))}
            onReject={(id) => void act(`reject-${id}`, () => request(`/profile/proposals/${id}`, { method: 'DELETE' }))}
            onKeep={(id) => void act(`keep-${id}`, () => request(`/profile/proposals/${id}/keep`, { method: 'PATCH' }))}
            onDelete={(id) => void act(`delete-${id}`, () => request(`/profile/${id}`, { method: 'DELETE' }))}
            onToggleStatus={(fact) => void act(`fact-${fact.id}`, () => request(`/profile/${fact.id}`, { method: 'PATCH', body: JSON.stringify({ status: fact.status === 'confirmed' ? 'proposed' : 'confirmed' }) }))}
          />
          <footer className="page-footer"><span>FIELDNOTE <i>·</i> YOUR APPLICATION WORKSPACE</span><span>Human judgment stays in the loop.</span></footer>
        </div>
      </section>

      {compose && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCompose(false); }}><form className="compose-modal" onSubmit={createJob}><div className="modal-heading"><div><span className="eyebrow">NEW OPPORTUNITY</span><h2>Add a role</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={() => setCompose(false)}><X size={18} /></button></div><label>Posting text<textarea name="posting" placeholder="Paste the full job posting here" rows={7} /></label><label className="file-input-label">Or attach a posting<input name="file" type="file" accept=".pdf,.docx,.txt,.md,.rtf,.png,.jpg,.jpeg,.webp" /><small>PDF, DOCX, text, or screenshot · 10 MB max</small></label><label>Source URL<input name="sourceUrl" type="url" placeholder="https://company.com/careers/role" /></label><label>Resolved apply URL<input name="applyUrl" type="url" placeholder="https://…" /></label><div className="modal-note"><ShieldCheck size={15} />Posting content is treated as untrusted data.</div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCompose(false)}>Cancel</button><button className="primary-button" disabled={Boolean(busy)}>{busy === 'create' ? <LoaderCircle className="spin" size={16} /> : <FilePlus2 size={16} />}Add to queue</button></div></form></div>}
    </main>
  );
}