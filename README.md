# Fieldnote Job Pipeline

A local-first job-application workspace with a NestJS API and Next.js dashboard. The API owns pipeline state, hard filters, score thresholds, and approval transitions; a configured OpenAI-compatible chat-completions endpoint runs the JSON-only stages.

## Run locally

1. Copy `.env.example` to `.env` and set `LLM_API_KEY`. `LLM_BASE_URL` and `LLM_MODEL` can point at another OpenAI-compatible provider.
2. Run `npm install` once at the repository root.
3. Run `npm run dev` and open [http://localhost:3000](http://localhost:3000). The API listens on port 4000.

The profile starts empty. Add facts and confirm them before scoring; only confirmed facts are passed to the model. Job and profile data are stored in `apps/api/data/state.json` by default. Set `STATE_PATH` to change that location. `BLOCKED_COMPANIES` accepts a comma-separated list.

The send step is deliberately manual: after approving a verified draft, use your mail client or application form, then mark the role sent in Fieldnote. This version does not connect to Gmail or submit applications.

## Pipeline

Add a posting, extract its stated details, apply code-owned location/deadline/company filters, and score it against confirmed profile facts. Unknown requirements produce a score range and can be collected into one shared question batch. Answers become proposed profile facts for your review. Apply recommendations produce a draft, followed by a separate verifier call and one redraft attempt. Only verified drafts can be approved.