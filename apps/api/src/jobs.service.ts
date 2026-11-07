import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store';
import { ModelClient } from './model-client';
import { CORE, STAGE1, STAGE2, STAGE3, STAGE4, STAGE5, STAGE6 } from './pipeline-prompts';
import { ExtractedJob, PipelineJob, PipelineState, ProfileLine } from './pipeline.types';

const OPENAI_PORTALS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'smartrecruiters.com', 'myworkdayjobs.com'];
const SCORE_WEIGHTS = { skills: 40, 'experience/qualifications': 20, location: 15, pay: 15, 'growth/mentorship': 10 };

@Injectable()
export class JobsService {
  constructor(private readonly store: JsonStore, private readonly model: ModelClient) {}

  async dashboard() {
    const state = await this.store.read();
    return { ...state, counts: state.jobs.reduce<Record<string, number>>((counts, job) => {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
      return counts;
    }, {}) };
  }

  async addJob(input: { posting?: string; sourceUrl?: string; applyUrl?: string }) {
    if (!input.posting?.trim()) throw new BadRequestException('Posting text is required.');
    const state = await this.store.read();
    const now = new Date().toISOString();
    const job: PipelineJob = {
      id: randomUUID(), createdAt: now, updatedAt: now, sourceUrl: input.sourceUrl?.trim() ?? '',
      applyUrl: input.applyUrl?.trim() ?? '', posting: input.posting.trim(), status: 'NEW',
    };
    state.jobs.unshift(job);
    await this.store.write(state);
    return job;
  }

  async extract(id: string) {
    const { state, job } = await this.getJob(id);
    if (!['NEW', 'EXTRACTED'].includes(job.status)) throw new BadRequestException('Only new jobs can be extracted.');
    const extraction = await this.model.json<ExtractedJob>(STAGE1, {
      source_url: job.sourceUrl, resolved_apply_url: job.applyUrl,
      job_posting: `<job_posting>${job.posting}</job_posting>`, profile: state.profile,
    });
    job.extraction = extraction;
    this.reviewApplyDomain(job);
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    this.applyHardFilters(job);
    if (job.status === 'EXTRACTED' && (extraction.reject.rule || extraction.legitimacy.verdict === 'fail')) job.status = 'REJECTED';
    await this.store.write(state);
    return job;
  }

  async score(id: string) {
    const { state, job } = await this.getJob(id);
    if (!job.extraction || !['EXTRACTED', 'SCORED', 'AWAITING_ANSWERS'].includes(job.status)) {
      throw new BadRequestException('Extract and pass hard filters before scoring.');
    }
    const result = await this.model.json<Record<string, any>>(STAGE2, {
      extraction: job.extraction,
      profile: state.profile.filter((line) => line.status === 'confirmed'),
    });
    const rawCriteria = Array.isArray(result.criteria) ? result.criteria : [];
    const criteria = Object.entries(SCORE_WEIGHTS).map(([name, max]) => {
      const item = rawCriteria.find((candidate: any) => candidate.name === name);
      const score = (value: unknown) => Math.max(0, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : 0));
      const scoreMin = score(item?.score_min);
      return {
        name, max, score_min: scoreMin, score_max: Math.max(scoreMin, score(item?.score_max)),
        reasoning: item?.reasoning ?? 'No criterion assessment returned.',
      };
    });
    const scoreMin = criteria.reduce((sum, item) => sum + item.score_min, 0);
    const scoreMax = criteria.reduce((sum, item) => sum + item.score_max, 0);
    const recommendation = scoreMin >= 65 ? 'apply' : scoreMax < 50 ? 'skip' : 'needs_answers';
    job.score = { ...result, criteria, score_min: scoreMin, score_max: scoreMax, recommendation };
    job.updatedAt = new Date().toISOString();
    job.status = recommendation === 'skip' ? 'SKIPPED' : recommendation === 'needs_answers' ? 'AWAITING_ANSWERS' : 'SCORED';
    if (recommendation === 'apply') await this.makeDraft(job, state);
    await this.store.write(state);
    return job;
  }

  async batchQuestions() {
    const state = await this.store.read();
    const candidates = state.jobs.filter((job) => job.status === 'AWAITING_ANSWERS');
    const grouped = new Map<string, { question_hint: string; job_ids: string[]; requirements: string[] }>();
    for (const job of candidates) {
      const list = (job.score?.unknowns as Array<Record<string, unknown>> | undefined) ?? [];
      for (const item of list) {
        const hint = String(item.question_hint ?? '').trim();
        const key = hint.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || `${job.id}:${String(item.req_id ?? randomUUID())}`;
        const group = grouped.get(key) ?? { question_hint: hint, job_ids: [], requirements: [] };
        if (!group.job_ids.includes(job.id)) group.job_ids.push(job.id);
        if (item.req_id) group.requirements.push(String(item.req_id));
        grouped.set(key, group);
      }
    }
    const unknowns = [...grouped.values()];
    if (!unknowns.length) return { questions: [] };
    const result = await this.model.json<{ questions: Array<Record<string, unknown>> }>(STAGE3, {
      unknowns, profile: state.profile,
    }, 1400);
    const validJobIds = new Set(candidates.map((job) => job.id));
    const seenQuestions = new Set<string>();
    const rankedQuestions = (result.questions ?? []).flatMap((question, index) => {
      const text = String(question.text ?? '').trim();
      const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || seenQuestions.has(key)) return [];
      seenQuestions.add(key);
      const unlocks = Array.isArray(question.unlocks_jobs)
        ? [...new Set(question.unlocks_jobs.map(String).filter((jobId) => validJobIds.has(jobId)))]
        : [];
      const swing = unlocks.reduce((sum, jobId) => {
        const job = candidates.find((candidate) => candidate.id === jobId);
        return sum + Math.max(0, Number(job?.score?.score_max ?? 0) - Number(job?.score?.score_min ?? 0));
      }, 0);
      return [{ question: {
        ...question, id: `Q${index + 1}`, text, unlocks_jobs: unlocks,
        impact: ['high', 'med', 'low'].includes(String(question.impact)) ? question.impact : 'low',
      }, rank: unlocks.length * swing }];
    });
    state.questions = rankedQuestions.sort((left, right) => right.rank - left.rank).slice(0, 5).map(({ question }) => question);
    await this.store.write(state);
    return { questions: state.questions };
  }

  async submitAnswers(input: { answers?: Array<{ id: string; answer: string }> }) {
    if (!input.answers?.length) throw new BadRequestException('Provide at least one answer.');
    const state = await this.store.read();
    const result = await this.model.json<Record<string, any>>(STAGE4, {
      questions: state.questions, answers: input.answers, profile: state.profile,
    }, 1800);
    state.proposedFacts = result.proposed_facts ?? [];
    for (const fact of state.proposedFacts) {
      fact.id = randomUUID();
      fact.status = 'proposed';
    }
    state.questions = [];
    await this.store.write(state);
    return { ...result, proposed_facts: state.proposedFacts };
  }

  async approveProfile(ids: string[]) {
    const state = await this.store.read();
    if (!ids.length) throw new BadRequestException('Select proposed facts to approve.');
    for (const fact of state.proposedFacts) {
      if (!ids.includes(String(fact.id))) continue;
      state.profile.push({ id: String(fact.id), text: String(fact.text), section: String(fact.section), status: 'confirmed' });
    }
    state.proposedFacts = state.proposedFacts.filter((fact) => !ids.includes(String(fact.id)));
    for (const line of state.profile) {
      if (line.status === 'proposed' && ids.includes(line.id)) line.status = 'confirmed';
    }
    await this.store.write(state);
    const jobs = await this.rescoreWaitingJobs(state.jobs.filter((job) => job.status === 'AWAITING_ANSWERS').map((job) => job.id));
    return { profile: (await this.store.read()).profile, jobs };
  }

  async addProfileLine(input: { text?: string; section?: string }) {
    if (!input.text?.trim()) throw new BadRequestException('Profile text is required.');
    const state = await this.store.read();
    const line: ProfileLine = {
      id: `P${state.profile.length + 1}`, text: input.text.trim(), section: input.section?.trim() || 'Experience', status: 'proposed',
    };
    state.profile.push(line);
    await this.store.write(state);
    return line;
  }

  async updateProfileLine(id: string, status: 'confirmed' | 'proposed') {
    const state = await this.store.read();
    const line = state.profile.find((item) => item.id === id);
    if (!line) throw new NotFoundException('Profile line not found.');
    line.status = status;
    await this.store.write(state);
    const jobs = status === 'confirmed'
      ? await this.rescoreWaitingJobs(state.jobs.filter((job) => job.status === 'AWAITING_ANSWERS').map((job) => job.id))
      : [];
    return { profile: line, jobs };
  }

  async draft(id: string) {
    const { state, job } = await this.getJob(id);
    if (job.status !== 'SCORED') throw new BadRequestException('Only jobs recommended for apply can be drafted.');
    await this.makeDraft(job, state);
    await this.store.write(state);
    return job;
  }

  async transition(id: string, action: 'approve' | 'sent' | 'skip') {
    const { state, job } = await this.getJob(id);
    if (action === 'approve' && job.status !== 'AWAITING_APPROVAL') throw new BadRequestException('Job must pass verification before approval.');
    if (action === 'sent' && job.status !== 'APPROVED') throw new BadRequestException('Only an approved job can be marked sent.');
    if (action === 'skip' && ['SENT', 'APPROVED'].includes(job.status)) throw new BadRequestException('Approved or sent jobs cannot be skipped.');
    job.status = action === 'approve' ? 'APPROVED' : action === 'sent' ? 'SENT' : 'SKIPPED';
    job.updatedAt = new Date().toISOString();
    await this.store.write(state);
    return job;
  }

  private async makeDraft(job: PipelineJob, state: PipelineState) {
    const input = { extraction: job.extraction, score: job.score, profile: state.profile.filter((line) => line.status === 'confirmed') };
    let draft = await this.model.json<Record<string, any>>(STAGE5, input, 2200);
    let verification = await this.model.json<Record<string, any>>(STAGE6, { draft, ...input }, 1200);
    if (verification.pass !== true) {
      draft = await this.model.json<Record<string, any>>(STAGE5, { ...input, verifier_issues: verification.issues }, 2200);
      verification = await this.model.json<Record<string, any>>(STAGE6, { draft, ...input }, 1200);
    }
    job.draft = draft;
    job.verification = verification;
    job.status = verification.pass === true ? 'AWAITING_APPROVAL' : 'DRAFTED';
    job.updatedAt = new Date().toISOString();
  }

  private applyHardFilters(job: PipelineJob) {
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
    const kenya = /\bkenya\b|\bnairobi\b|\bmombasa\b|\bkisumu\b/.test(location);
    if (extraction.remote === 'no' && !kenya) {
      job.status = 'FILTERED_OUT'; job.filterReason = 'Role is not remote and is not located in Kenya.'; return;
    }
    if (extraction.remote === 'yes' || kenya || extraction.remote === 'unclear') job.status = 'EXTRACTED';
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

  private async getJob(id: string) {
    const state = await this.store.read();
    const job = state.jobs.find((item) => item.id === id);
    if (!job) throw new NotFoundException('Job not found.');
    return { state, job };
  }

  private async rescoreWaitingJobs(ids: string[]) {
    const jobs = [];
    for (const id of ids) jobs.push(await this.score(id));
    return jobs;
  }
}