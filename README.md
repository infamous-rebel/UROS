# UROS — Universal Recruitment Operations System

Deterministic, configurable, human-in-the-loop, multi-agent recruitment & HR
operations platform for Bangladesh. No black-box AI — every decision is
traceable to a human-defined, versioned rule.

See `progress.md` for build status and `docs/` for architecture notes.

## Quick Start

```bash
cp deploy/env-templates/.env.example .env
npm install
npm run migrate
npm test
```

## Structure

- `src/agents` — Intake, Parser, Eligibility, Scoring, Ranking, HIL Supervisor,
  Verification, Communication agents
- `src/rules` — Rule pack definitions + deterministic evaluator engine
- `src/database` — Migrations + Postgres client
- `src/services/orchestrator` — Pipeline stages + human-in-the-loop gates
- `src/models` — Typed data contracts
- `src/utils` — Logging, audit helper, error types
- `src/config` — Zod-validated environment config
- `tests/unit`, `tests/integration`
- `deploy` — Docker, CI/CD, env templates
- `scripts` — Migration runner CLI, seed data, backup/restore
