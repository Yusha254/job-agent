export type JobStatus =
  | 'NEW'
  | 'EXTRACTED'
  | 'FILTERED_OUT'
  | 'REJECTED'
  | 'SCORED'
  | 'AWAITING_ANSWERS'
  | 'DRAFTED'
  | 'VERIFIED'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'SENT'
  | 'SKIPPED';

export type ProfileLine = {
  id: string;
  text: string;
  section: string;
  status: 'confirmed' | 'proposed';
  source?: string;
  sourceUrl?: string;
  evidence?: string;
};

export type UserSettings = {
  name: string;
  homeLocation: string;
  githubUrl: string;
  applyThreshold: number;
  skipThreshold: number;
  weights: {
    skills: number;
    'experience/qualifications': number;
    location: number;
    pay: number;
    'growth/mentorship': number;
  };
};

export type ExtractedJob = {
  company: string | null;
  role: string | null;
  location: string | null;
  remote: 'yes' | 'no' | 'unclear';
  pay: { stated: string | null; signals: string[] };
  contract: string | null;
  seniority_required: string | null;
  apply: { method: 'email' | 'form' | 'test' | 'unknown'; target: string | null };
  deadline: string | null;
  requirements: Array<{ id: string; text: string; type: 'must' | 'nice'; kind: string }>;
  legitimacy: { verdict: 'pass' | 'flag' | 'fail'; reasons: string[] };
  reject: { rule: string | null; reason: string | null };
};

export type PipelineJob = {
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceUrl: string;
  applyUrl: string;
  posting: string;
  attachmentName?: string;
  status: JobStatus;
  extraction?: ExtractedJob;
  score?: Record<string, unknown>;
  draft?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  filterReason?: string;
  error?: string;
};

export type PipelineState = {
  settings: UserSettings;
  profile: ProfileLine[];
  jobs: PipelineJob[];
  questions: Array<Record<string, unknown>>;
  proposedFacts: Array<Record<string, unknown>>;
};