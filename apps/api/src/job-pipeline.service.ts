import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseStore } from './database.store';
import { DocumentReader } from './document-reader';
import type { UploadedDocument } from './document-reader';
import { CORE, STAGE1, STAGE2, STAGE3, STAGE4, STAGE5, STAGE6 } from './pipeline-prompts';
import { ProfileService } from './profile.service';
import { ExtractedJob, PipelineJob, UserSettings } from './pipeline.types';
import { ModelClient } from './model-client';

const OPENAI_PORTALS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'smartrecruiters.com', 'myworkdayjobs.com'];

@Injectable()
export class JobPipelineService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly model: ModelClient,
    private readonly documents: DocumentReader,
    private readonly profiles: ProfileService,
  ) {}

  async dashboard() {
    const [settings, jobs, profile, proposedFacts, questions] = await Promise.all([
      this.store.getSettings(), this.store.listJobs(), this.store.listProfile(),
      this.store.listProposedFacts(), this.store.getQuestions(),
    ]);
    const counts = jobs.reduce<Record<string, number>>((result, job) => {
      result[job.status] = (result[job.status] ?? 0) + 1;
      return result;
    }, {});
    return { settings, jobs, profile, proposedFacts, questions, counts };
  }

  async addJob(input: { posting?: string; sourceUrl?: string; applyUrl?: string }, file?: UploadedDocument) {
    const posting = file ? await this.documents.read(file) : input.posting?.trim();
    if (!posting) throw new BadRequestException('Paste the posting or upload a supported file.');
    const now = new Date().toISOString();
    const job: PipelineJob = {
      id: randomUUID(), createdAt: now, updatedAt: now, sourceUrl: input.sourceUrl?.trim() ?? '',
      applyUrl: input.applyUrl?.trim() ?? '', posting, attachmentName: file?.originalname, status: 'NEW',
    };
    return this.store.createJob(job);
  }

  async extract(id: string) {
    const [job, settings, profile] = await Promise.all([this.requireJob(id), this.store.getSettings(), this.store.listProfile()]);
    if (!['NEW', 'EXTRACTED'].includes(job.status)) throw new BadRequestException('Only new jobs can be extracted.');
    const extraction = await this.model.json<ExtractedJob>(this.prompt(STAGE1, settings), {
      source_url: job.sourceUrl, resolved_apply_url: job.applyUrl,
      job_posting: `<job_posting>${job.posting}</job_posting>`, profile,
    });
    job.extraction = extraction;
    this.reviewApplyDomain(job);
    job.error = undefined;
    job.filterReason = undefined;
    this.applyHardFilters(job, settings.homeCity, settings.homeCountry);
    if (job.status === 'EXTRACTED' && (extraction.reject.rule || extraction.legitimacy.verdict === 'fail')) job.status = 'REJECTED';
    job.updatedAt = new Date().toISOString();
    await this.store.updateJob(id, job);
    return job;
  }

  async score(id: string) {
    const [job, settings, profile] = await Promise.all([this.requireJob(id), this.store.getSettings(), this.store.listProfile()]);
    if (!job.extraction || !['EXTRACTED', 'SCORED', 'AWAITING_ANSWERS'].includes(job.status)) {
      throw new BadRequestException('Extract and pass hard filters before scoring.');
    }
    const result = await this.model.json<Record<string, any>>(this.prompt(STAGE2, settings), {
      extraction: job.extraction, profile: profile.filter((line) => line.status === 'confirmed'),
    });
    const rawCriteria = Array.isArray(result.criteria) ? result.criteria : [];
    const criteria = Object.entries(settings.weights).map(([name, max]) => {
      const item = rawCriteria.find((candidate: any) => candidate.name === name);
      const score = (value: unknown) => Math.max(0, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : 0));
      const scoreMin = score(item?.score_min);
      return { name, max, score_min: scoreMin, score_max: Math.max(scoreMin, score(item?.score_max)), reasoning: item?.reasoning ?? 'No criterion assessment returned.' };
    });
    const scoreMin = criteria.reduce((sum, item) => sum + item.score_min, 0);
    const scoreMax = criteria.reduce((sum, item) => sum + item.score_max, 0);
    const recommendation = scoreMin >= settings.applyThreshold ? 'apply' : scoreMax < settings.skipThreshold ? 'skip' : 'needs_answers';
    job.score = { ...result, criteria, score_min: scoreMin, score_max: scoreMax, recommendation };
    job.updatedAt = new Date().toISOString();
    job.status = recommendation === 'skip' ? 'SKIPPED' : recommendation === 'needs_answers' ? 'AWAITING_ANSWERS' : 'SCORED';
    if (recommendation === 'apply') await this.makeDraft(job, settings);
    await this.store.updateJob(id, job);
    return job;
  }

  async batchQuestions() {
    const candidates = await this.store.listAwaitingJobs();
    const grouped = new Map<string, { question_hint: string; job_ids: string[]; requirements: string[] }>();
    for (const job of candidates) {
      const unknowns = (job.score?.unknowns as Array<Record<string, unknown>> | undefined) ?? [];
      for (const item of unknowns) {
        const hint = String(item.question_hint ?? '').trim();
        const key = hint.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || `${job.id}:${String(item.req_id ?? randomUUID())}`;
        const group = grouped.get(key) ?? { question_hint: hint, job_ids: [], requirements: [] };
        if (!group.job_ids.includes(job.id)) group.job_ids.push(job.id);
        if (item.req_id) group.requirements.push(String(item.req_id));
        grouped.set(key, group);
      }
    }
    if (!grouped.size) return { questions: [] };
    const [settings, profile] = await Promise.all([this.store.getSettings(), this.store.listProfile()]);
    const result = await this.model.json<{ questions: Array<Record<string, unknown>> }>(this.prompt(STAGE3, settings), {
      unknowns: [...grouped.values()], profile,
    }, 1400);
    const validJobIds = new Set(candidates.map((job) => job.id));
    const seen = new Set<string>();
    const ranked = (result.questions ?? []).flatMap((question, index) => {
      const text = String(question.text ?? '').trim();
      const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || seen.has(key)) return [];
      seen.add(key);
      const unlocks = Array.isArray(question.unlocks_jobs) ? [...new Set(question.unlocks_jobs.map(String).filter((jobId) => validJobIds.has(jobId)))] : [];
      const swing = unlocks.reduce((sum, jobId) => {
        const job = candidates.find((candidate) => candidate.id === jobId);
        return sum + Math.max(0, Number(job?.score?.score_max ?? 0) - Number(job?.score?.score_min ?? 0));
      }, 0);
      return [{ question: {
        ...question, id: `Q${index + 1}`, text, unlocks_jobs: unlocks,
        impact: ['high', 'med', 'low'].includes(String(question.impact)) ? question.impact : 'low',
      }, rank: unlocks.length * swing }];
    });
    const questions = ranked.sort((left, right) => right.rank - left.rank).slice(0, 5).map(({ question }) => question);
    await this.store.replaceQuestions(questions);
    return { questions };
  }

  async submitAnswers(input: { answers?: Array<{ id: string; answer: string }> }) {
    if (!input.answers?.length) throw new BadRequestException('Provide at least one answer.');
    const [questions, settings, profile] = await Promise.all([this.store.getQuestions(), this.store.getSettings(), this.store.listProfile()]);
    const result = await this.model.json<Record<string, any>>(this.prompt(STAGE4, settings), {
      questions, answers: input.answers, profile,
    }, 1800);
    const facts = (result.proposed_facts ?? []).map((fact: Record<string, unknown>) => ({ ...fact, id: randomUUID(), status: 'proposed' }));
    const proposals = await this.profiles.createProposals(facts, 'Your answer', '');
    await this.store.replaceQuestions([]);
    return { ...result, proposed_facts: proposals };
  }

  async draft(id: string) {
    const [job, settings] = await Promise.all([this.requireJob(id), this.store.getSettings()]);
    if (job.status !== 'SCORED') throw new BadRequestException('Only jobs recommended for apply can be drafted.');
    await this.makeDraft(job, settings);
    await this.store.updateJob(id, job);
    return job;
  }

  async transition(id: string, action: 'approve' | 'sent' | 'skip') {
    const job = await this.requireJob(id);
    if (action === 'approve' && job.status !== 'AWAITING_APPROVAL') throw new BadRequestException('Job must pass verification before approval.');
    if (action === 'sent' && job.status !== 'APPROVED') throw new BadRequestException('Only an approved job can be marked sent.');
    if (action === 'skip' && ['SENT', 'APPROVED'].includes(job.status)) throw new BadRequestException('Approved or sent jobs cannot be skipped.');
    job.status = action === 'approve' ? 'APPROVED' : action === 'sent' ? 'SENT' : 'SKIPPED';
    job.updatedAt = new Date().toISOString();
    await this.store.updateJob(id, job);
    return job;
  }

  async rescoreWaitingJobs() {
    const jobs = await this.store.listAwaitingJobs();
    const updated = [];
    for (const job of jobs) updated.push(await this.score(job.id));
    return updated;
  }

  private async makeDraft(job: PipelineJob, settings: UserSettings) {
    const profile = await this.store.listProfile();
    const input = { extraction: job.extraction, score: job.score, profile: profile.filter((line) => line.status === 'confirmed') };
    let draft = await this.model.json<Record<string, any>>(this.prompt(STAGE5, settings), input, 2200);
    let verification = await this.model.json<Record<string, any>>(this.prompt(STAGE6, settings), { draft, ...input }, 1200);
    if (verification.pass !== true) {
      draft = await this.model.json<Record<string, any>>(this.prompt(STAGE5, settings), { ...input, verifier_issues: verification.issues }, 2200);
      verification = await this.model.json<Record<string, any>>(this.prompt(STAGE6, settings), { draft, ...input }, 1200);
    }
    job.draft = draft;
    job.verification = verification;
    job.status = verification.pass === true ? 'AWAITING_APPROVAL' : 'DRAFTED';
    job.updatedAt = new Date().toISOString();
  }

  private applyHardFilters(job: PipelineJob, homeCity = '', homeCountry = 'Kenya') {
    const extraction = job.extraction!;
    const blocked = (process.env.BLOCKED_COMPANIES ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
    if (extraction.company && blocked.includes(extraction.company.toLowerCase())) {
      job.status = 'FILTERED_OUT'; job.filterReason = 'Company is on the blocked list.'; return;
    }
    if (extraction.deadline) {
      const deadline = Date.parse(extraction.deadline);
      if (Number.isFinite(deadline) && deadline < Date.now()) {
        job.status = 'FILTERED_OUT'; job.filterReason = 'Application deadline has passed.'; return;
      }
    }
    const location = extraction.location?.toLowerCase() ?? '';
    const city = homeCity.trim().toLowerCase();
    const country = homeCountry.trim().toLowerCase();
    const localCities = country === 'kenya' ? /\b(nairobi|mombasa|kisumu|nakuru|eldoret)\b/.test(location) : false;
    const isLocal = Boolean((city && location.includes(city)) || (country && location.includes(country)) || localCities);
    if (extraction.remote === 'no' && !isLocal) {
      job.status = 'FILTERED_OUT'; job.filterReason = `Role is not remote and is not located in ${[homeCity, homeCountry].filter(Boolean).join(', ')}.`; return;
    }
    if (extraction.remote === 'yes' || isLocal || extraction.remote === 'unclear') job.status = 'EXTRACTED';
  }

  private reviewApplyDomain(job: PipelineJob) {
    const extraction = job.extraction!;
    const target = job.applyUrl || extraction.apply?.target || '';
    let hostname = '';
    const emailDomain = target.match(/@([^>\s]+)/)?.[1]?.toLowerCase();
    if (emailDomain) hostname = emailDomain;
    else try {
      hostname = new URL(target.includes('@') && !target.includes('://') ? `mailto:${target}` : target).hostname.toLowerCase();
    } catch {
      hostname = target.includes('@') ? target.split('@').pop()?.toLowerCase() ?? '' : '';
    }
    const companyTokens = (extraction.company ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !['limited', 'company', 'group', 'holdings', 'incorporated'].includes(token));
    const matchesCompany = companyTokens.some((token) => hostname.includes(token));
    const knownPortal = OPENAI_PORTALS.some((portal) => hostname === portal || hostname.endsWith(`.${portal}`));
    const personalEmail = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'protonmail.com'].some((domain) => hostname === domain);
    const reasons = extraction.legitimacy?.reasons ?? [];
    if (personalEmail && !reasons.some((reason) => reason.toLowerCase().includes('personal email'))) reasons.push('Application uses a personal email domain.');
    if ((!hostname || (!matchesCompany && !knownPortal)) && !reasons.some((reason) => reason.toLowerCase().includes('apply domain'))) reasons.push('Apply domain could not be matched to the company or a known applicant-tracking portal.');
    extraction.legitimacy = extraction.legitimacy ?? { verdict: 'flag', reasons: [] };
    extraction.legitimacy.reasons = reasons;
    if (reasons.length && extraction.legitimacy.verdict === 'pass') extraction.legitimacy.verdict = 'flag';
  }

  private async requireJob(id: string) {
    const job = await this.store.getJob(id);
    if (!job) throw new NotFoundException('Job not found.');
    return job;
  }

  private prompt(template: string, settings: UserSettings) {
    return template
      .replaceAll('{{PERSON_NAME}}', settings.name)
      .replaceAll('{{HOME_LOCATION}}', [settings.homeCity, settings.homeCountry].filter(Boolean).join(', '))
      .replaceAll('{{APPLY_THRESHOLD}}', String(settings.applyThreshold))
      .replaceAll('{{SKIP_THRESHOLD}}', String(settings.skipThreshold))
      .replace(/\{\{WEIGHT:([^}]+)}}/g, (_match, name: string) => String(settings.weights[name as keyof UserSettings['weights']] ?? 0));
  }
}
