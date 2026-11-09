import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseStore } from './database.store';
import { UserSettings } from './pipeline.types';

@Injectable()
export class SettingsService {
  constructor(private readonly store: DatabaseStore) {}

  get() {
    return this.store.getSettings();
  }

  async update(input: Partial<UserSettings>) {
    const current = await this.store.getSettings();
    const next = { ...current, ...input, weights: { ...current.weights, ...input.weights } };
    if (!next.name.trim() || !next.homeCountry.trim()) throw new BadRequestException('Name and home country are required.');
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
    return this.store.saveSettings(next);
  }
}
