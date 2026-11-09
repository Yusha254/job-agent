import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseStore } from './database.store';
import { DocumentReader } from './document-reader';
import type { UploadedDocument } from './document-reader';
import { FACT_DEDUPE, PROFILE_IMPORT } from './pipeline-prompts';
import { ModelClient } from './model-client';
import { ProfileLine } from './pipeline.types';

@Injectable()
export class ProfileService {
  constructor(private readonly store: DatabaseStore, private readonly model: ModelClient, private readonly documents: DocumentReader) {}

  async list() {
    return this.store.listProfile();
  }

  async listProposed() {
    return this.store.listProposedFacts();
  }

  async addFact(input: { text?: string; section?: string }) {
    if (!input.text?.trim()) throw new BadRequestException('Profile text is required.');
    const fact = {
      id: randomUUID(), text: input.text.trim(), section: input.section?.trim() || 'Experience',
      source: 'Manual entry',
    };
    return this.createProposals([fact], 'Manual entry', '');
  }

  async importCV(file?: UploadedDocument) {
    if (!file) throw new BadRequestException('Choose a CV file to import.');
    const extension = file.originalname.split('.').pop()?.toLowerCase() ?? 'unknown';
    let phase = 'document parsing';
    try {
      const text = await this.documents.read(file);
      phase = 'model profile extraction';
      const settings = await this.store.getSettings();
      const escapedContent = text.slice(0, 40000).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const result = await this.model.json<{ proposed_facts?: Array<Record<string, unknown>> }>(this.profilePrompt(PROFILE_IMPORT, settings.name), {
        web_content: `<web_content>${escapedContent}</web_content>`, source: `CV upload (${extension})`,
      }, 3000);
      const facts = await this.createProposals(result.proposed_facts ?? [], `CV upload (${extension})`, '');
      console.info(`[CV import] completed: ${extension}, ${file.buffer.length} bytes`);
      return { proposed_facts: facts };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown failure';
      console.error(`[CV import] failed during ${phase}: ${extension}, ${file.buffer.length} bytes (${reason})`);
      throw error;
    }
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
    const settings = await this.store.getSettings();
    const escapedContent = content.slice(0, 40000).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const result = await this.model.json<{ proposed_facts?: Array<Record<string, unknown>> }>(this.profilePrompt(PROFILE_IMPORT, settings.name), {
      web_content: `<web_content>${escapedContent}</web_content>`, source: `GitHub: ${profileUrl}`,
    }, 3000);
    const facts = await this.createProposals(result.proposed_facts ?? [], `GitHub: ${profileUrl}`, profileUrl);
    await this.store.saveSettings({ ...settings, githubUrl: profileUrl });
    return { proposed_facts: facts };
  }

  async approve(ids: string[]) {
    if (!ids.length) throw new BadRequestException('Select proposed facts to approve.');
    await this.store.approveProposedFacts(ids);
    return this.store.listProfile();
  }

  async reject(id: string) {
    await this.store.removeProposedFacts([id]);
    return { rejected: id };
  }

  async keepProposal(id: string) {
    await this.store.saveProposedFactMatches(id, []);
    return { id, matches: [] };
  }

  async deleteFact(id: string) {
    await this.store.deleteProfileFact(id);
    return { deleted: id };
  }

  async updateStatus(id: string, status: ProfileLine['status']) {
    const facts = await this.store.listProfile();
    if (!facts.some((fact) => fact.id === id)) throw new NotFoundException('Profile line not found.');
    await this.store.setProfileStatus(id, status);
    return { ...(facts.find((fact) => fact.id === id) as ProfileLine), status };
  }

  async createProposals(candidates: Array<Record<string, unknown>>, source: string, sourceUrl: string) {
    const profile = await this.store.listProfile();
    const proposed = await this.store.listProposedFacts();
    const existing = [...profile, ...proposed].map((fact) => ({ id: String(fact.id), section: fact.section, text: fact.text }));
    const facts = candidates
      .filter((fact) => typeof fact.text === 'string' && fact.text.trim())
      .map((fact) => ({
        ...fact,
        id: randomUUID(), text: String(fact.text), section: String(fact.section ?? 'Experience'),
        status: 'proposed', source, sourceUrl: sourceUrl || undefined,
        matches: [] as Array<Record<string, unknown>>,
      }));

    if (existing.length && facts.length) {
      try {
        const result = await this.model.json<{ matches?: Array<Record<string, unknown>> }>(FACT_DEDUPE, {
          existing_facts: existing,
          candidate_facts: facts.map((fact) => ({ id: fact.id, section: fact.section, text: fact.text })),
        }, 1200);
        for (const match of result.matches ?? []) {
          const candidate = facts.find((fact) => fact.id === match.candidate_id);
          if (candidate) candidate.matches.push({ id: match.existing_id, reason: match.reason });
        }
      } catch {
        console.warn('[profile] Semantic duplicate check unavailable; proposals were saved without duplicate suggestions.');
      }
    }
    await this.store.createProposedFacts(facts);
    return facts;
  }

  private profilePrompt(template: string, name: string) {
    return template.replaceAll('{{PERSON_NAME}}', name);
  }

  private githubUsername(url: string) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || segments.length !== 1 || !/^[a-z\d-]{1,39}$/i.test(segments[0])) throw new Error('invalid');
      return segments[0];
    } catch {
      throw new BadRequestException('Enter a public profile URL such as https://github.com/username.');
    }
  }

  private repositorySummary(repo: Record<string, any>) {
    return { name: repo.name, description: repo.description, language: repo.language, url: repo.html_url, updated_at: repo.updated_at };
  }

  private async githubJson<T>(url: string, headers: Record<string, string>, timeoutMs = 10000): Promise<T> {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 403) throw new BadRequestException('GitHub rate limit reached. Try again later.');
      if (!response.ok) throw new BadRequestException(`GitHub API returned HTTP ${response.status} for ${new URL(url).pathname}.`);
      return await response.json() as T;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const reason = error instanceof Error ? error.message : 'unknown network error';
      throw new BadRequestException(`GitHub API request failed: ${reason}`);
    }
  }
}
