import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PipelineState } from './pipeline.types';

const EMPTY_STATE: PipelineState = { profile: [], jobs: [], questions: [], proposedFacts: [] };

@Injectable()
export class JsonStore {
  private readonly filePath = process.env.STATE_PATH ?? join(process.cwd(), 'data', 'state.json');
  private pendingWrite: Promise<void> = Promise.resolve();

  async read(): Promise<PipelineState> {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      return { ...EMPTY_STATE, ...JSON.parse(contents) } as PipelineState;
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