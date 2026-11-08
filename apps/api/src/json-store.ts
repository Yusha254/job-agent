import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PipelineState, UserSettings } from './pipeline.types';

export const DEFAULT_SETTINGS: UserSettings = {
  name: 'Joshua Kyalo',
  homeLocation: 'Kenya',
  githubUrl: '',
  applyThreshold: 65,
  skipThreshold: 50,
  weights: { skills: 40, 'experience/qualifications': 20, location: 15, pay: 15, 'growth/mentorship': 10 },
};

const EMPTY_STATE: PipelineState = { settings: DEFAULT_SETTINGS, profile: [], jobs: [], questions: [], proposedFacts: [] };

@Injectable()
export class JsonStore {
  private readonly filePath = process.env.STATE_PATH ?? join(process.cwd(), 'data', 'state.json');
  private pendingWrite: Promise<void> = Promise.resolve();

  async read(): Promise<PipelineState> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      const saved = JSON.parse(contents) as Partial<PipelineState>;
      return {
        ...EMPTY_STATE,
        ...saved,
        settings: {
          ...DEFAULT_SETTINGS,
          ...saved.settings,
          weights: { ...DEFAULT_SETTINGS.weights, ...saved.settings?.weights },
        },
      } as PipelineState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return structuredClone(EMPTY_STATE);
    }
  }

  async write(state: PipelineState): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(state, null, 2), 'utf8');
    });
    await this.pendingWrite;
  }
}