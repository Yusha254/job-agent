import { UserSettings } from './pipeline.types';

export const DEFAULT_SETTINGS: UserSettings = {
  name: 'Joshua Kyalo',
  homeCity: '',
  homeCountry: 'Kenya',
  githubUrl: '',
  applyThreshold: 65,
  skipThreshold: 50,
  weights: { skills: 40, 'experience/qualifications': 20, location: 15, pay: 15, 'growth/mentorship': 10 },
};