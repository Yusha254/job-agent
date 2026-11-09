import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS } from './pipeline.defaults';
import { PipelineJob, PipelineState, ProfileLine, UserSettings } from './pipeline.types';

@Injectable()
export class DatabaseStore extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    await this.importLegacyStateIfEmpty();
    await this.settings.upsert({
      where: { id: 1 },
      create: this.settingsData(DEFAULT_SETTINGS),
      update: {},
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async getSettings(): Promise<UserSettings> {
    const row = await this.settings.findUniqueOrThrow({ where: { id: 1 } });
    return {
      name: row.name,
      homeCity: row.homeCity,
      homeCountry: row.homeCountry,
      githubUrl: row.githubUrl,
      applyThreshold: row.applyThreshold,
      skipThreshold: row.skipThreshold,
      weights: row.weights as UserSettings['weights'],
    };
  }

  async saveSettings(settings: UserSettings) {
    await this.settings.upsert({ where: { id: 1 }, create: this.settingsData(settings), update: this.settingsData(settings) });
    return settings;
  }

  async listJobs(): Promise<PipelineJob[]> {
    const rows = await this.job.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
    return rows.map((row) => this.jobFromRow(row));
  }

  async listAwaitingJobs(): Promise<PipelineJob[]> {
    const rows = await this.job.findMany({ where: { status: 'AWAITING_ANSWERS' }, orderBy: { updatedAt: 'desc' } });
    return rows.map((row) => this.jobFromRow(row));
  }

  async getJob(id: string): Promise<PipelineJob | undefined> {
    const row = await this.job.findUnique({ where: { id } });
    return row ? this.jobFromRow(row) : undefined;
  }

  async createJob(job: PipelineJob) {
    await this.job.create({ data: this.jobCreateData(job) });
    return job;
  }

  async updateJob(id: string, changes: Partial<PipelineJob>) {
    const { id: _id, createdAt: _createdAt, ...rest } = changes;
    await this.job.update({ where: { id }, data: { ...this.jobFields(rest), updatedAt: new Date() } });
  }

  async listProfile(): Promise<ProfileLine[]> {
    return this.profileFact.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }).then((rows) => rows.map((row) => ({
      id: row.id, text: row.text, section: row.section, status: row.status as ProfileLine['status'],
      source: row.source ?? undefined, sourceUrl: row.sourceUrl ?? undefined, evidence: row.evidence ?? undefined,
    })));
  }

  async createProfileFact(fact: ProfileLine) {
    await this.profileFact.create({ data: {
      id: fact.id, text: fact.text, section: fact.section, status: fact.status,
      source: fact.source, sourceUrl: fact.sourceUrl, evidence: fact.evidence,
    } });
    return fact;
  }

  async setProfileStatus(id: string, status: ProfileLine['status']) {
    await this.profileFact.update({ where: { id }, data: { status } });
  }

  async deleteProfileFact(id: string) {
    await this.profileFact.delete({ where: { id } });
  }

  async listProposedFacts(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.proposedFact.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => row.payload as Record<string, unknown>);
  }

  async createProposedFacts(facts: Array<Record<string, unknown>>) {
    if (!facts.length) return;
    await this.proposedFact.createMany({ data: facts.map((fact) => ({
      id: String(fact.id), text: String(fact.text ?? ''), section: String(fact.section ?? 'Experience'),
      source: typeof fact.source === 'string' ? fact.source : undefined,
      sourceUrl: typeof fact.sourceUrl === 'string' ? fact.sourceUrl : undefined,
      evidence: typeof fact.evidence === 'string' ? fact.evidence : undefined,
      matches: Array.isArray(fact.matches) ? fact.matches as Prisma.InputJsonValue : undefined,
      payload: fact as Prisma.InputJsonValue,
    })) });
  }

  async removeProposedFacts(ids: string[]) {
    if (!ids.length) return;
    await this.proposedFact.deleteMany({ where: { id: { in: ids } } });
  }

  async saveProposedFactMatches(id: string, matches: Array<Record<string, unknown>>) {
    const row = await this.proposedFact.findUnique({ where: { id } });
    if (!row) return;
    const payload = row.payload as Record<string, unknown>;
    const next = { ...payload, matches } as Prisma.InputJsonValue;
    await this.proposedFact.update({ where: { id }, data: { matches: matches as Prisma.InputJsonValue, payload: next } });
  }

  async approveProposedFacts(ids: string[]) {
    if (!ids.length) return [];
    return this.$transaction(async (transaction) => {
      const proposals = await transaction.proposedFact.findMany({ where: { id: { in: ids } } });
      const facts = proposals.map((proposal) => proposal.payload as Record<string, unknown>);
      if (facts.length) {
        await transaction.profileFact.createMany({ data: facts.map((fact) => ({
          id: String(fact.id), text: String(fact.text), section: String(fact.section ?? 'Experience'), status: 'confirmed',
          source: typeof fact.source === 'string' ? fact.source : undefined,
          sourceUrl: typeof fact.sourceUrl === 'string' ? fact.sourceUrl : undefined,
          evidence: typeof fact.evidence === 'string' ? fact.evidence : undefined,
        })) });
        await transaction.proposedFact.deleteMany({ where: { id: { in: proposals.map((proposal) => proposal.id) } } });
      }
      return facts;
    });
  }

  async getQuestions(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.pipelineQuestion.findMany({ orderBy: { position: 'asc' } });
    return rows.map((row) => row.payload as Record<string, unknown>);
  }

  async replaceQuestions(questions: Array<Record<string, unknown>>) {
    await this.$transaction(async (transaction) => {
      await transaction.pipelineQuestion.deleteMany();
      if (questions.length) await transaction.pipelineQuestion.createMany({ data: questions.map((question, position) => ({
        id: String(question.id), position, payload: question as Prisma.InputJsonValue,
      })) });
    });
  }

  private settingsData(settings: UserSettings) {
    return {
      id: 1, name: settings.name, homeCity: settings.homeCity, homeCountry: settings.homeCountry,
      githubUrl: settings.githubUrl, applyThreshold: settings.applyThreshold, skipThreshold: settings.skipThreshold,
      weights: settings.weights as Prisma.InputJsonValue,
    };
  }

  private jobFields(job: Partial<PipelineJob>): Prisma.JobUncheckedUpdateInput {
    return {
      ...(job.sourceUrl !== undefined ? { sourceUrl: job.sourceUrl } : {}),
      ...(job.applyUrl !== undefined ? { applyUrl: job.applyUrl } : {}),
      ...(job.posting !== undefined ? { posting: job.posting } : {}),
      ...(job.attachmentName !== undefined ? { attachmentName: job.attachmentName } : {}),
      ...(job.status !== undefined ? { status: job.status } : {}),
      ...(job.extraction !== undefined ? { extraction: job.extraction as Prisma.InputJsonValue } : {}),
      ...(job.score !== undefined ? { score: job.score as Prisma.InputJsonValue } : {}),
      ...(job.draft !== undefined ? { draft: job.draft as Prisma.InputJsonValue } : {}),
      ...(job.verification !== undefined ? { verification: job.verification as Prisma.InputJsonValue } : {}),
      ...(job.filterReason !== undefined ? { filterReason: job.filterReason } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
    };
  }

  private jobCreateData(job: PipelineJob): Prisma.JobCreateManyInput {
    return {
      id: job.id, createdAt: new Date(job.createdAt), updatedAt: new Date(job.updatedAt),
      sourceUrl: job.sourceUrl, applyUrl: job.applyUrl, posting: job.posting, status: job.status,
      attachmentName: job.attachmentName, extraction: job.extraction as Prisma.InputJsonValue | undefined,
      score: job.score as Prisma.InputJsonValue | undefined, draft: job.draft as Prisma.InputJsonValue | undefined,
      verification: job.verification as Prisma.InputJsonValue | undefined, filterReason: job.filterReason, error: job.error,
    };
  }

  private jobFromRow(row: Prisma.JobGetPayload<Record<string, never>>): PipelineJob {
    return {
      id: row.id, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      sourceUrl: row.sourceUrl, applyUrl: row.applyUrl, posting: row.posting,
      attachmentName: row.attachmentName ?? undefined, status: row.status as PipelineJob['status'],
      extraction: row.extraction as PipelineJob['extraction'], score: row.score as PipelineJob['score'],
      draft: row.draft as PipelineJob['draft'], verification: row.verification as PipelineJob['verification'],
      filterReason: row.filterReason ?? undefined, error: row.error ?? undefined,
    };
  }

  private async importLegacyStateIfEmpty() {
    if (await this.settings.findUnique({ where: { id: 1 } })) return;
    const state = await this.readLegacyState();
    const settings = this.normalizeLegacySettings(state.settings);
    await this.$transaction(async (transaction) => {
      await transaction.settings.create({ data: this.settingsData(settings) });
      if (state.jobs.length) await transaction.job.createMany({ data: state.jobs.map((job) => this.jobCreateData(job)) });
      if (state.profile.length) await transaction.profileFact.createMany({ data: state.profile.map((fact) => ({
        id: fact.id, text: fact.text, section: fact.section, status: fact.status,
        source: fact.source, sourceUrl: fact.sourceUrl, evidence: fact.evidence,
      })) });
      if (state.proposedFacts.length) await transaction.proposedFact.createMany({ data: state.proposedFacts.map((fact) => ({
        id: String(fact.id), text: String(fact.text ?? ''), section: String(fact.section ?? 'Experience'),
        source: typeof fact.source === 'string' ? fact.source : undefined,
        sourceUrl: typeof fact.sourceUrl === 'string' ? fact.sourceUrl : undefined,
        evidence: typeof fact.evidence === 'string' ? fact.evidence : undefined,
        matches: Array.isArray(fact.matches) ? fact.matches as Prisma.InputJsonValue : undefined,
        payload: fact as Prisma.InputJsonValue,
      })) });
      if (state.questions.length) await transaction.pipelineQuestion.createMany({ data: state.questions.map((question, position) => ({
        id: String(question.id), position, payload: question as Prisma.InputJsonValue,
      })) });
    });
    console.info(`[database] Imported legacy state: ${state.jobs.length} jobs, ${state.profile.length} facts, ${state.proposedFacts.length} proposals.`);
  }

  private async readLegacyState(): Promise<PipelineState> {
    const configured = process.env.LEGACY_STATE_PATH ?? process.env.STATE_PATH;
    const paths = configured
      ? [resolve(process.cwd(), configured), resolve(process.cwd(), 'apps/api', configured)]
      : [resolve(process.cwd(), 'data/state.json'), resolve(process.cwd(), 'apps/api/data/state.json')];
    for (const filePath of [...new Set(paths)]) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<PipelineState>;
        return {
          settings: this.normalizeLegacySettings(parsed.settings), jobs: parsed.jobs ?? [], profile: parsed.profile ?? [],
          proposedFacts: parsed.proposedFacts ?? [], questions: parsed.questions ?? [],
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { settings: DEFAULT_SETTINGS, jobs: [], profile: [], proposedFacts: [], questions: [] };
  }

  private normalizeLegacySettings(settings?: Partial<UserSettings> & { homeLocation?: string }): UserSettings {
    const legacyLocation = settings?.homeLocation?.split(',').map((part) => part.trim()) ?? [];
    const homeCity = settings?.homeCity ?? (legacyLocation.length > 1 ? legacyLocation[0] : '');
    const homeCountry = settings?.homeCountry ?? (legacyLocation.length > 1 ? legacyLocation.slice(1).join(', ') : legacyLocation[0] || DEFAULT_SETTINGS.homeCountry);
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      homeCity,
      homeCountry,
      weights: { ...DEFAULT_SETTINGS.weights, ...settings?.weights },
    };
  }
}
