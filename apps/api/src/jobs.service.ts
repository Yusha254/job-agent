import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store';
import { ModelClient } from './model-client';
import { DocumentReader } from './document-reader';
import type { UploadedDocument } from './document-reader';
import { CORE, PROFILE_IMPORT, STAGE1, STAGE2, STAGE3, STAGE4, STAGE5, STAGE6 } from './pipeline-prompts';
import { ExtractedJob, PipelineJob, PipelineState, ProfileLine, UserSettings } from './pipeline.types';

const OPENAI_PORTALS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'smartrecruiters.com', 'myworkdayjobs.com'];

@Injectable()
export class JobsService {
  constructor(private readonly store: JsonStore, private readonly model: ModelClient, private readonly documents: DocumentReader) {}

  async dashboard() {
    const state = await this.store.read();
    return { ...state, counts: state.jobs.reduce<Record<string, number>>((counts, job) => {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
      return counts;
    }, {}) };
  }

  async getSettings() {
    return (await this.store.read()).settings;
  }

  async updateSettings(input: Partial<UserSettings>) {
    const state = await this.store.read();
    const next = { ...state.settings, ...input, weights: { ...state.settings.weights, ...input.weights } };
    if (!next.name.trim() || !next.homeLocation.trim()) throw new BadRequestException('Name and home location are required.');
    if (!Number.isFinite(next.skipThreshold) || !Number.isFinite(next.applyThreshold)
      || next.skipThreshold < 0 || next.skipThreshold > 100
      || next.applyThreshold < 0 || next.applyThreshold > 100
      || next.skipThreshold >= next.applyThreshold) {
      throw new BadRequestException('Use thresholds from 0 to 100, with the skip threshold lower than the apply threshold.');
    }
    const weightTotal = Object.values(next.weights).reduce((sum, weight) => sum + weight, 0);
    if (Object.values(next.weights).some((weight) => !Number.isFinite(weight) || weight < 0) || Math.abs(weightTotal - 100) > 0.0001) {
      throw new BadRequestException('Score weights must be non-negative and add up to 100.');
    }
    state.settings = next;
    await this.store.write(state);
    return state.settings;
  }

  async addJob(input: { posting?: string; sourceUrl?: string; applyUrl?: string }, file?: UploadedDocument) {
    const posting = file ? await this.documents.read(file) : input.posting?.trim();
    if (!posting) throw new BadRequestException('Paste the posting or upload a supported file.');
    const state = await this.store.read();
    const now = new Date().toISOString();
    const job: PipelineJob = {
      id: randomUUID(), createdAt: now, updatedAt: now, sourceUrl: input.sourceUrl?.trim() ?? '',
      applyUrl: input.applyUrl?.trim() ?? '', posting, attachmentName: file?.originalname, status: 'NEW',
    };
    state.jobs.unshift(job);
    await this.store.write(state);
    return job;
  }

  async extract(id: string) {
    const { state, job } = await this.getJob(id);
    if (!['NEW', 'EXTRACTED'].includes(job.status)) throw new BadRequestException('Only new jobs can be extracted.');
    const extraction = await this.model.json<ExtractedJob>(this.prompt(STAGE1, state.settings), {
      source_url: job.sourceUrl, resolved_apply_url: job.applyUrl,
      job_posting: `<job_posting>${job.posting}</job_posting>`, profile: state.profile,
    });
    job.extraction = extraction;
    this.reviewApplyDomain(job);
    job.error = undefined;
    job.updatedAt = new Date().toISOString();
    this.applyHardFilters(job, state.settings.homeLocation);
    if (job.status === 'EXTRACTED' && (extraction.reject.rule || extraction.legitimacy.verdict === 'fail')) job.status = 'REJECTED';
    await this.store.write(state);
    return job;
  }

  async score(id: string) {
    const { state, job } = await this.getJob(id);
    if (!job.extraction || !['EXTRACTED', 'SCORED', 'AWAITING_ANSWERS'].includes(job.status)) {
      throw new BadRequestException('Extract and pass hard filters before scoring.');
    }
    const result = await this.model.json<Record<string, any>>(this.prompt(STAGE2, state.settings), {
      extraction: job.extraction,
      profile: state.profile.filter((line) => line.status === 'confirmed'),
    });
    const rawCriteria = Array.isArray(result.criteria) ? result.criteria : [];
    const criteria = Object.entries(state.settings.weights).map(([name, max]) => {
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
    const recommendation = scoreMin >= state.settings.applyThreshold ? 'apply' : scoreMax < state.settings.skipThreshold ? 'skip' : 'needs_answers';
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
    const result = await this.model.json<{ questions: Array<Record<string, unknown>> }>(this.prompt(STAGE3, state.settings), {
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
    const result = await this.model.json<Record<string, any>>(this.prompt(STAGE4, state.settings), {
      questions: state.questions, answers: input.answers, profile: state.profile,
    }, 1800);
    const proposedFacts = result.proposed_facts ?? [];
    for (const fact of proposedFacts) {
      fact.id = randomUUID();
      fact.status = 'proposed';
      fact.source = 'Your answer';
    }
    state.proposedFacts.push(...proposedFacts);
    state.questions = [];
    await this.store.write(state);
    return { ...result, proposed_facts: proposedFacts };
  }

  async importProfile(file?: UploadedDocument) {
    if (!file) throw new BadRequestException('Choose a CV file to import.');
    const text = await this.documents.read(file);
    return this.proposeProfileFacts(text, `CV: ${file.originalname}`, '');
  }

  async importGithub(url: string) {
    const username = this.githubUsername(url);
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Fieldnote-Job-Pipeline' };
    const profile = await this.githubJson<Record<string, any>>(`https://api.github.com/users/${encodeURIComponent(username)}`, headers);
    const repositories = (await this.githubJson<Array<Record<string, any>>>(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=30`, headers))
      .filter((repo) => !repo.fork && !repo.archived)
      .slice(0, 8);
    const repositoriesWithReadmes = await Promise.all(repositories.map(async (repo) => {
      try {
        const readme = await this.githubJson<{ content?: string; encoding?: string }>(
          `https://api.github.com/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/readme`, headers, 8000,
        );
        const decoded = readme.encoding === 'base64' ? Buffer.from(readme.content ?? '', 'base64').toString('utf8') : '';
        return { ...this.repositorySummary(repo), readme: decoded.slice(0, 3500) };
      } catch {
        return { ...this.repositorySummary(repo), readme: '' };
      }
    }));
    const profileUrl = `https://github.com/${username}`;
    const content = JSON.stringify({
      name: profile.name, bio: profile.bio, location: profile.location, profile_url: profile.html_url,
      repositories: repositoriesWithReadmes,
    });
    const result = await this.proposeProfileFacts(content, `GitHub: ${profileUrl}`, profileUrl);
    const state = await this.store.read();
    state.settings.githubUrl = profileUrl;
    await this.store.write(state);
    return result;
  }

  async approveProfile(ids: string[]) {
    const state = await this.store.read();
    if (!ids.length) throw new BadRequestException('Select proposed facts to approve.');
    for (const fact of state.proposedFacts) {
      if (!ids.includes(String(fact.id))) continue;
      state.profile.push({
        id: String(fact.id), text: String(fact.text), section: String(fact.section), status: 'confirmed',
        source: typeof fact.source === 'string' ? fact.source : undefined,
        sourceUrl: typeof fact.sourceUrl === 'string' ? fact.sourceUrl : undefined,
        evidence: typeof fact.evidence === 'string' ? fact.evidence : undefined,
      });
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
    let draft = await this.model.json<Record<string, any>>(this.prompt(STAGE5, state.settings), input, 2200);
    let verification = await this.model.json<Record<string, any>>(this.prompt(STAGE6, state.settings), { draft, ...input }, 1200);
    if (verification.pass !== true) {
      draft = await this.model.json<Record<string, any>>(this.prompt(STAGE5, state.settings), { ...input, verifier_issues: verification.issues }, 2200);
      verification = await this.model.json<Record<string, any>>(this.prompt(STAGE6, state.settings), { draft, ...input }, 1200);
    }
    job.draft = draft;
    job.verification = verification;
    job.status = verification.pass === true ? 'AWAITING_APPROVAL' : 'DRAFTED';
    job.updatedAt = new Date().toISOString();
  }

  private applyHardFilters(job: PipelineJob, homeLocation = 'Kenya') {
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
    const home = homeLocation.toLowerCase();
    const localCities = home === 'kenya' ? /\b(nairobi|mombasa|kisumu|nakuru|eldoret)\b/.test(location) : false;
    const isLocal = location.includes(home) || localCities;
    if (extraction.remote === 'no' && !isLocal) {
      job.status = 'FILTERED_OUT'; job.filterReason = `Role is not remote and is not located in ${homeLocation}.`; return;
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

  private githubUsername(url: string) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || segments.length !== 1 || !/^[a-z\d-]{1,39}$/i.test(segments[0])) {
        throw new Error('invalid');
      }
      return segments[0];
    } catch {
      throw new BadRequestException('Enter a public profile URL such as https://github.com/username.');
    }
  }

  private repositorySummary(repo: Record<string, any>) {
    return {
      name: repo.name, description: repo.description, language: repo.language,
      url: repo.html_url, updated_at: repo.updated_at,
    };
  }

  private async githubJson<T>(url: string, headers: Record<string, string>, timeoutMs = 10000): Promise<T> {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 403) throw new BadRequestException('GitHub rate limit reached. Try again later.');
      if (!response.ok) throw new BadGatewayException(`GitHub API returned HTTP ${response.status} for ${new URL(url).pathname}.`);
      return await response.json() as T;
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof BadGatewayException) throw error;
      const reason = error instanceof Error ? error.message : 'unknown network error';
      throw new BadGatewayException(`GitHub API request failed: ${reason}`);
    }
  }

  private async proposeProfileFacts(content: string, source: string, sourceUrl: string) {
    const state = await this.store.read();
    const escapedContent = content.slice(0, 40000).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const result = await this.model.json<{ proposed_facts?: Array<Record<string, unknown>> }>(this.prompt(PROFILE_IMPORT, state.settings), {
      web_content: `<web_content>${escapedContent}</web_content>`, source,
    }, 3000);
    const facts = (Array.isArray(result.proposed_facts) ? result.proposed_facts : [])
      .filter((fact) => typeof fact.text === 'string' && fact.text.trim())
      .map((fact) => ({
        ...fact,
        id: randomUUID(),
        status: 'proposed',
        source,
        sourceUrl: sourceUrl || undefined,
      }));
    state.proposedFacts.push(...facts);
    await this.store.write(state);
    return { proposed_facts: facts };
  }

  private prompt(template: string, settings: UserSettings) {
    return template
      .replaceAll('{{PERSON_NAME}}', settings.name)
      .replaceAll('{{HOME_LOCATION}}', settings.homeLocation)
      .replaceAll('{{APPLY_THRESHOLD}}', String(settings.applyThreshold))
      .replaceAll('{{SKIP_THRESHOLD}}', String(settings.skipThreshold))
      .replace(/\{\{WEIGHT:([^}]+)}}/g, (_match, name: string) => String(settings.weights[name as keyof UserSettings['weights']] ?? 0));
  }
}