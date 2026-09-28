# UROS — Build Progress

Tracks phases completed, what's shipped, and what's next.

---

## Phase 1 — Architecture & Schema ✅ Complete
Production folder tree; full PostgreSQL schema; `REVOKE UPDATE, DELETE ON
audit_log` for immutability.

## Phase 2 — Core Engine, Orchestrator, Migrations, Models, Config, Tests ✅ Complete
Migrations `0001`–`0005`; rule engine (`operators.ts`, `evaluator.ts`,
`conflict_checker.ts`); orchestrator `pipeline.ts` (8 stages) +
`hil_gates.ts`; agent stubs; typed models; zod env config; winston logger;
audit helper; unit tests.

## Phase 3 — API Layer & Authentication ✅ Complete
`src/api/server.ts`; middleware (`auth.ts`, `rbac.ts`, `rate_limit.ts`,
`validate.ts`, `error_handler.ts`); 9 route files; `hil_gates.resolveGate()`
wired to `POST /gates/:gateId/resolve`; tests for rbac, validate, gates.

## Phase 4 — Integrations, Queue, Webhooks, Real Agent Logic ✅ Complete
7 BYOK connectors; queue `producer.ts`/`consumer.ts` (idempotent, `FOR
UPDATE SKIP LOCKED`); inbound webhook route; real `parser_agent` (Tesseract
OCR), `scoring_agent`, `ranking_agent`, `verification_agent`; migrations
`0006`–`0008`; tests for SMS retry, queue idempotency, webhook signatures.

## Phase 5 — BYOK Credential API, Webhook Scheduler, LISTEN Gate Resolver, Dashboard UI ✅ Complete
`credentials.routes.ts` (CRUD, masked keys, budget caps, ADMIN-only);
`scheduler.ts` (fixed backoff 1m/5m/15m/1h/6h/24h → DEAD); `gate_listener.ts`
(Postgres `LISTEN/NOTIFY` replacing DB polling); `src/ui/` dashboard shell
(React + Vite + TanStack Query + Tailwind, UROS color system, command bar +
pipeline strip + decision queue + audit stream, no dead space); migrations
`0009`–`0010`; tests for encryption/masking, scheduler backoff, LISTEN/NOTIFY
resolution, UI smoke test.

---

## Phase 6 — Appeals, Task Logs, Onboarding, KPI, Personas, Improvement Advisor ✅ Complete

### 1. Appeals (extended, not rebuilt)
- New `appeal_triage_agent`: `classifyAppealText()` (deterministic keyword
  match, a *suggestion* only — the applicant's own submitted category
  always governs), `computePriority()`, `assignReviewer()` (deterministic
  least-open-appeals load-balance across `SENIOR_RECRUITER`s — not ML).
  `triageAppeal()` runs automatically on submission, moving status
  `SUBMITTED → TRIAGED`; never resolves the appeal itself.
- `appeals.routes.ts` extended: `GET /appeals` (Applicant sees only their
  own; Senior Recruiter/Admin/Auditor see all), `GET /appeals/:id`,
  `PATCH /appeals/:id` (Senior Recruiter/Admin only; mandatory `resolution`
  text; audit-logged as `APPEAL_UNDER_REVIEW`/`APPEAL_RESOLVED`).

### 2. Task Logs (migration `0011_task_logs.sql`)
- `task_logs(task_id, org_id, assignee_id, created_by, title, description,
  priority, status, due_date, completed_at, closure_approved_by, ...)`.
- `task_log_agent`: `flagOverdueTasks()`, `sendDueReminders()` (pre-approved
  low-risk automation — reminders only, never marks anything complete;
  recorded via `audit_log` since `communication_log.candidate_id` is
  applicant-scoped and NOT NULL, not reusable for internal task reminders
  — **assumption stated inline**).
- `task_logs.routes.ts`: `POST /`, `GET /` (non-privileged roles
  implicitly scoped to their own assignments), `PATCH /:id` (assignee
  updates their own status, or a manager/admin), `POST /:id/approve-closure`
  (**human-in-loop task closure**: agent flags overdue, only a manager/
  admin/dept-head can approve final closure after the assignee marks
  `DONE` — enforced with a 409 if attempted out of order).

### 3. Onboarding (migration `0012_employees_onboarding.sql`)
- `employees`, `onboarding_templates` (checklist as JSONB), 
  `onboarding_assignments`.
- `onboarding_agent`: `createAssignmentsFromTemplate()` (deterministic 1:1
  expansion of a template into per-employee assignments, with due dates
  computed from `default_due_days`), `flagOverdueAssignments()`,
  `completionRate()`.
- `onboarding.routes.ts`: template CRUD (Admin), employee creation,
  `POST /employees/:employeeId/assign`, `GET .../checklist`,
  `PATCH /assignments/:id` — **HR/manager confirms every item**; the
  agent only flags, never completes.

### 4. KPI (migration `0013_kpi.sql`)
- `kpi_definitions(role, name, formula JSONB, cycle, band_thresholds)`,
  `kpi_scores(..., calculated_score, breakdown, band, approved_score,
  reviewer_id, status, override_reason)`, unique on
  `(kpi_id, employee_id, period)`.
- `kpi_agent.computeScore()`: deterministic weighted sum —
  `score = Σ(metric_value × weight / 100)` — every term visible in
  `breakdown`, no hidden model. Formula weights validated to sum to 100
  at creation (`kpi.routes.ts` zod `.refine`). Band assigned from
  `band_thresholds` (e.g. Outstanding/Good/Average/Below Average per
  file 09 §2).
- `kpi.routes.ts`: `POST /definitions` (Dept Head/Admin), `POST
  /scores/calculate` (produces `CALCULATED`, awaiting approval), `GET
  /scores`, `PATCH /scores/:id/approve` — **manager approves as-calculated
  or overrides with a mandatory `override_reason` + `approved_score`**
  (zod `.refine` enforces both together, mirroring the eligibility
  evaluator's override pattern).

### 5. Departmental Personas (migration `0014_personas_improvements.sql`)
- `personas(department, job_family, name, version)`,
  `persona_requirements(field_path, operator, value, weight)` — **reuses
  the exact same `operator` enum and `applyOperator()` from the
  eligibility rule engine** (file 09 §5's "Right Person – Right Job"
  matching), so persona fit scoring behaves identically to eligibility/
  scoring evaluation — one deterministic engine, three use sites.
- `persona_agent.evaluateFit()`: weight-normalized (always sums to 100
  regardless of how requirement weights were entered) proportional fit
  score with `matched`/`unmatched` field lists, fully explainable.
- `personas.routes.ts`: `POST /` (HR/Dept Head builds persona +
  requirements together), `GET /`, `POST /:id/evaluate` (scores a
  profile; **human decides** what to do with the result — no
  auto-matching to a role).

### 6. Improvement Advisor (same migration `0014`)
- `improvement_suggestions(employee_id, persona_id, gap_type, suggestion,
  source, status, assigned_to, reviewed_by)`.
- `improvement_advisor_agent.identifyGaps()`: **gap detection is always
  deterministic** — (a) latest approved KPI score below a fixed threshold
  (70), (b) persona requirements the employee's profile doesn't currently
  satisfy (via the same `persona_agent.evaluateFit()`). The *decision*
  that a gap exists and what kind never depends on an LLM.
- Optional BYOK LLM rephrasing (`maybeRephraseWithLlm()`): if an org has
  configured an `llm` credential, the deterministic suggestion text is
  passed through a chat-completion call for warmer phrasing only: on any
  failure, missing credential, or timeout, it silently falls back to the
  deterministic text (`source: "DETERMINISTIC"` vs `"LLM_BYOK"` recorded
  either way). **Assumption stated once**: `llm` was added to
  `ConnectorName` for type-safety, but is *not yet* in the
  `api_credentials` CHECK constraint or exposed via `POST /credentials`
  — `getCredential()` is a read-only SELECT (unaffected by the CHECK,
  which only restricts INSERTs), so this degrades safely to "always
  deterministic" until a future migration widens the constraint and a
  route allows storing one.
- `improvements.routes.ts`: `POST /generate` (Admin/Dept Head triggers
  the agent), `GET /`, `PATCH /:id` — **manager approves or rejects,
  HR assigns** (`assigned_to` required when status becomes `HR_ASSIGNED`,
  zod-enforced).

### HR Ops Scheduler (`src/services/hr_ops/scheduler.ts`)
- Sweeps every org: `flagOverdueTasks()` + `sendDueReminders()` (task
  logs), `flagOverdueAssignments()` (onboarding) — same
  start/stop-idempotent, `unref()`'d interval pattern as the Phase 5
  webhook scheduler. Runnable via `npm run hr-ops-scheduler`.

### Dashboard UI
- Six new panels (`AppealsPanel`, `TaskLogsPanel`, `OnboardingPanel`,
  `KpiPanel`, `PersonasPanel`, `ImprovementsPanel`), each following the
  established no-dead-space contract (not-connected / loading / error /
  empty-with-context / loaded, never a blank render) — see shared
  `components/EmptyState.tsx`.
- `App.tsx` restructured with tab navigation (Recruitment / Appeals /
  Task Logs / Onboarding / KPI / Personas / Improvement Advisor); the
  Audit Stream sidebar stays visible across every tab.
- New `src/ui/src/api/hooks_hr.ts` — TanStack Query hooks + mutations for
  all six modules, reusing the Phase 5 dev-token auth pattern.

### Assumptions Made This Phase (stated once each, inline in code + here)
1. Human-in-the-loop for these modules uses **direct approval endpoints**
   (`PATCH .../approve`, `POST .../approve-closure`, etc.) rather than the
   heavier `gate_events`/LISTEN-NOTIFY mechanism from the recruitment
   pipeline. That mechanism was built for long, multi-day batch-review
   waits; single-record HR approvals (a task closure, a KPI score, an
   appeal) are synchronous human actions with no "waiting pipeline" to
   resume — a lighter pattern is the right fit, not a shortcut.
2. Task/onboarding reminders are audit-logged rather than written to
   `communication_log` (schema-incompatible: candidate-scoped, NOT NULL
   `candidate_id`). A dedicated internal-notifications table is a natural
   Phase 7 addition if these need their own queryable history distinct
   from the general audit trail.
3. `llm` BYOK connector is type-declared but not yet persistable (see
   Improvement Advisor section above) — deliberately degrades to
   deterministic-only behavior rather than failing.
4. Onboarding assignment due dates are computed via raw SQL interval
   interpolation (`now() + interval '${days} days'`) driven by a
   validated positive integer from the template JSON — not user input at
   request time — so this is not a SQL-injection surface, but is flagged
   for a parameterized rewrite before wider input sources touch it.

### Tests Added
- `tests/unit/agents/kpi_agent.test.ts` — weighted-sum formula matches
  hand-calculated expectation; missing metrics default to 0 without
  throwing; band assignment across all four thresholds; determinism.
- `tests/unit/agents/persona_agent.test.ts` — full match → 100; partial
  match → proportional score + correct `unmatched` list; missing profile
  field counts as unmatched (never throws); non-100-summing weights are
  normalized correctly; determinism.
- `src/ui/tests/App.test.tsx` extended with a tab-switching smoke test
  (Task Logs panel renders its empty state without crashing).

### Known Gaps / Carried Forward
- All Known Gaps from Phases 1–5 remain open (see prior sections) —
  notably: no login UI, approximate pipeline stage counts, `email`
  connector IMAP/Gmail transport, no Docker/CI, `scripts/seed_test_data.ts`
  unimplemented.
- `llm` connector not yet insertable via the Credentials API (assumption 3)
- No dedicated internal-notifications table (assumption 2) — task/
  onboarding reminders are audit-log-only, not user-facing "inbox" items
- `hr_ops_scheduler` and `webhook_scheduler` both need a real process
  manager / Docker service entry in Phase 7's deploy work — currently
  run manually (`npm run hr-ops-scheduler`, `npm run webhook-scheduler`)
- Onboarding UI's "Employee Checklist" lookup requires pasting a raw
  employee UUID (no employee search/picker yet)
- Tests are authored but not executed in this environment (no network
  access for `npm install`, consistent with all prior phases)

---

## Phase 7 — Deploy & Ops (Production Hardening) ✅ Complete

### 1. Docker
- `deploy/docker/Dockerfile.api` — 4-stage build (deps → build → prod-deps
  → runtime), `node:20-alpine`, fixed non-root UID/GID 10001, dependency-
  free `HEALTHCHECK` (`deploy/docker/healthcheck.js`, built-in `http` only).
  One image serves four processes via compose `command` overrides: API,
  queue worker, webhook scheduler, HR-ops scheduler — same deterministic
  codebase, different entry point.
- `deploy/docker/Dockerfile.ui` — Vite build → `nginxinc/nginx-unprivileged`
  (non-root by default). `nginx.conf.template` reverse-proxies `/api/`,
  `/health` to the API service by env-substituted upstream
  (`UROS_API_UPSTREAM`) — dashboard calls are same-origin, no CORS needed
  for the UI itself.

### 2. Docker Compose
- `docker-compose.yml` (cloud/standard) — postgres, redis, `migrate` (runs
  once via `condition: service_completed_successfully`, idempotent —
  `schema_migrations` tracks applied files), api, worker,
  webhook-scheduler, hr-ops-scheduler, ui. Named volumes.
- `docker-compose.onprem.yml` — same service graph, host bind-mounts
  (`./data/...`) instead of opaque named volumes for data-sovereignty
  visibility (file 03 §4, file 20 §2), only `ui` published to the host,
  everything else on an internal-only bridge network, resource limits,
  inline note on true air-gap (build/pull once, `docker save`/`load`
  thereafter).

### 3. CI/CD
- `deploy/ci-cd/github-actions/deploy.yml` (mirrored to
  `.github/workflows/deploy.yml`, the path GitHub actually reads):
  lint → typecheck → test (coverage) → advisory `npm audit` → build →
  push GHCR images (tagged by git SHA + `latest`) → migrate → deploy
  (documented stub for the org's actual mechanism) → smoke test gate.
  `rollback_to_tag` input reuses an already-pushed image, skips CI/build/
  migrate, re-runs the smoke test.
- `deploy/ci-cd/github-actions/migrate.yml` — standalone migration-only
  workflow (for expand/contract schema changes ahead of a full deploy);
  requires typing the environment name to confirm for `production`
  (human-in-the-loop applied to infrastructure, mirroring the
  override-requires-a-reason pattern already used for candidate decisions).

### 4. Security hardening (building on Phase 3's helmet/cors/JWT/RBAC/zod)
- `CORS_ALLOWED_ORIGINS` (comma list, was previously hardcoded open),
  `TRUST_PROXY` (explicit opt-in — not `z.coerce.boolean()`, which has a
  known gotcha of coercing the *string* `"false"` to `true`; used
  `z.enum(["true","false"]).transform(...)` instead).
  A global defense-in-depth rate limiter (300 req/min) now sits alongside
  the existing route-specific presets.
- `/metrics` gated by optional `METRICS_TOKEN` (bearer or
  `X-Metrics-Token`); open by default with a documented recommendation to
  protect it at the network layer instead when unset.
- `npm run audit` (`npm audit --omit=dev --audit-level=high`) wired into
  CI as an advisory (non-blocking) step.

### 5. Monitoring
- `src/api/middleware/request_id.ts` — every request gets a stable
  `request_id` (honors inbound `X-Request-Id`, else generates one),
  echoed on the response and included in every structured log line and
  every error response.
- `src/utils/health.ts` — `/health` now actually checks: `database`
  (`SELECT 1`), `redis` (`PING`, `not_configured` when `REDIS_URL` unset),
  `queue` (mirrors redis or database depending on which backend is
  active), `encryption` (round-trips a probe string through
  `encryptSecret`/`decryptSecret`). `database`/`encryption` down → overall
  `down` (503); anything else down → `degraded` (still 200, still serving).
- `src/utils/metrics.ts` — dependency-free Prometheus text-format
  registry (Counter/Gauge/Histogram in ~140 lines; no `prom-client`, kept
  auditable and installable-without-network). `/metrics` exposes
  `uros_http_requests_total`, `uros_http_request_duration_ms`,
  `uros_evaluation_jobs_total`, `uros_audit_log_writes_total`,
  `uros_webhook_deliveries_total`, `uros_process_uptime_seconds`,
  `uros_health_check_status`. Instrumented at a small number of central
  chokepoints (`audit_helper.logAudit` covers *every* audited action
  system-wide automatically; queue producer/consumer; webhook scheduler)
  rather than scattered per-route, so new modules get metrics for free
  as long as they call `logAudit` — which every route already does.

### 6. Backup & DR
- `scripts/backup.sh` — `pg_dump --format=custom` + `DOCUMENT_STORAGE_PATH`
  tar snapshot + manifest, packaged and encrypted with
  `openssl enc -aes-256-cbc -pbkdf2` under `BACKUP_ENCRYPTION_PASSPHRASE`,
  checksum written alongside, local retention pruning.
- `scripts/restore.sh` — **human-in-the-loop by design**: requires
  `--confirm` and typing the target database name back before touching
  anything; decrypts, `pg_restore --clean --if-exists`, replaces the
  document directory, re-runs migrations.
- `scripts/dr_drill.sh` — restores the latest (or a given) backup into an
  **isolated throwaway Postgres container**, never the real
  `DATABASE_URL`; runs integrity checks (`schema_migrations` count, key
  tables reachable, document entry count); exit code gates PASS/FAIL.
  Satisfies file 20 §2.3's "DR drill every 6 months".

### 7. Post-deploy smoke test
- `scripts/smoke_test.sh` — read-only, safe to run repeatedly against
  production. Checks `/health` (200/503, never a network error),
  `/metrics` (200 with `METRICS_TOKEN`, 401 without one when a token is
  configured — proving the gate is actually enforced, not just present),
  and `/api/v1/candidates` returns `401` (not `500`) both with no token
  and with a garbage token. Wired as the cutover gate in `deploy.yml`.

### 8. Environment configs
- `deploy/env-templates/.env.example` / `.env.onprem.example` — added
  `CORS_ALLOWED_ORIGINS`, `TRUST_PROXY`, `METRICS_TOKEN`,
  `DOCUMENT_STORAGE_PATH`, `BACKUP_ENCRYPTION_PASSPHRASE`,
  `BACKUP_OUTPUT_DIR`, `BACKUP_RETENTION_DAYS`, each documented inline
  with generation commands and the reasoning behind cloud vs on-prem
  defaults (e.g. `METRICS_TOKEN` recommended-on for on-prem as
  defense-in-depth even though the network is already internal-only).

### 9. Runbooks (`docs/runbooks/`)
- `deploy.md` — environments, standard/manual deploy steps, rollback
  policy (application rollback vs. why migrations are forward-only and
  must stay backward-compatible for one deploy cycle), pre-flight
  checklist.
- `backup_restore.md` — backup contents/scheduling, restore procedure
  (including cross-environment restore), DR drill cadence + a log table
  template, RTO/RPO targets, encryption key handling/rotation caveats.
- `troubleshooting.md` — how to read every `/health` field and what to
  do about each failure mode, `/metrics` interpretation (including the
  per-process rate-limiter caveat under horizontal scaling), Docker
  `HEALTHCHECK` failures, request-ID-based log correlation.

### Bugs found and fixed while building this phase
1. **`tsconfig.json` `rootDir: "./"` with `include` spanning
   `src/`+`tests/`+`scripts/`** would have (a) emitted to
   `dist/src/api/server.js`, not matching the `dist/api/server.js` every
   Dockerfile/compose/package.json script already assumed, and (b) swept
   the browser-only `src/ui/src/*.ts` files (using `localStorage`,
   `fetch`, `import.meta`) into the Node-targeted backend compile,
   breaking `npm run build` outright. Fixed: `rootDir: "./src"`,
   `include: ["src/**/*.ts"]`, `exclude` adds `src/ui`. Tests/scripts are
   still fully covered — ts-jest transpiles test files independently of
   `include`, and `scripts/*.ts` run via `ts-node` the same way.
2. **Migration SQL files never reached `dist/`.** `tsc` only compiles
   `.ts`; `src/database/migrations/*.sql` (read at runtime via
   `path.join(__dirname, "migrations")`) were silently absent from the
   production image, so `migrate` would have applied zero migrations on
   first boot. Fixed: `npm run build` now also runs
   `build:copy-assets` (`cp src/database/migrations/*.sql
   dist/database/migrations/`).
3. **`npm run lint` had no ESLint installed and no config at all** —
   would fail immediately in CI regardless of code correctness. Added
   `eslint`/`@typescript-eslint/*` as devDependencies and a minimal
   `.eslintrc.json` scoped to the backend (`src/ui` excluded — it's a
   separate Vite/React toolchain).
4. Would-be footgun avoided rather than introduced: `TRUST_PROXY` uses
   `z.enum(["true","false"]).transform(...)`, not `z.coerce.boolean()`
   (which coerces the literal string `"false"` to `true` — a real zod
   gotcha that would have silently defeated an operator's explicit
   `TRUST_PROXY=false`).

### Assumptions Made This Phase
1. The `deploy` step in `deploy.yml` is a documented stub, not a real
   `ssh`/cloud-CLI call — actual deploy targets (which host, which cloud
   provider, which container service) are organisation-specific and
   weren't specified. The contract (image tag in, environment in) is
   fixed so swapping in a real mechanism doesn't change anything else in
   the pipeline.
2. Redis is treated as re-derivable, not backed up: the evaluation queue
   falls back to a Postgres poll worker when Redis is unavailable (see
   `checkQueue()` in `src/utils/health.ts`), so Redis holds no data that
   isn't also durably recorded in Postgres via `producer.ts`.
3. `/metrics` cardinality is bounded by using the matched Express route
   *pattern* (`/candidates/:id`), not the raw path, as a label — avoids
   one time series per candidate ID.
4. The in-memory rate limiter (Phase 3) remains per-process for this
   phase — documented as a known limitation for horizontal scaling in
   `troubleshooting.md` §6, not silently upgraded to a Redis-backed one
   (that's a real behavior change, out of this phase's explicit scope).

### Known Gaps / Carried Forward
- All Known Gaps from Phases 1–6 remain open except the ones this phase
  explicitly closes (Docker/CI, scheduler process entries — worker/
  webhook-scheduler/hr-ops-scheduler now have real compose service
  definitions).
- No login UI still (Phase 5/6 gap) — smoke test and runbooks work
  around this using the existing dev-token pattern / direct API auth.
- Rate limiter is still single-process/in-memory (assumption 4 above);
  a Redis-backed shared limiter is the natural next step if/when running
  more than one API replica.
- `scripts/seed_test_data.ts` referenced by `npm run seed` still doesn't
  exist (pre-existing gap, not touched this phase — out of Phase 7's
  explicit scope).
- No Kubernetes manifests (`deploy/k8s/` still empty) — Docker Compose
  only, per this phase's explicit deliverable list.
- Tests are authored but not executed in this environment (no network
  access for `npm install`), consistent with all prior phases; reviewed
  the full diff manually line-by-line instead, including tracing every
  modified file against the existing Jest mocks to confirm no breakage.

---

## Feature 1 — 7-Dimension Candidate Matching System ✅ Complete
(`UROS_Master_Feature_Documentation.md` Feature 1, Tier 3.) Built on top
of Phases 1–7 without modifying any existing module — additive only.

- **Migration `0015_dimension_matching.sql`**: 4 new tables —
  `dimension_templates` (built-in + org-saved templates; `org_id IS NULL`
  = built-in, seeded with `UROS_CORE_7` and `INDUSTRY_7`, each with its
  own default 7-dimension set), `dimension_configs` (one row per
  dimension; `org_id IS NULL` rows are a template's un-scored defaults,
  `org_id`-set rows are an org's active configuration, optionally scoped
  to a `persona_id`), `dimension_subcriteria` (rule-engine sub-criteria
  per dimension — same `operator` enum as eligibility/persona rules),
  `candidate_dimension_scores` (one row per scoring run, full visible
  `dimension_breakdown` JSONB evidence, `status`/`human_reviewer`/
  `human_decision`/`override_reason` for the human-in-loop gate).
- **`dimension.model.ts`**: full TypeScript types for configs,
  sub-criteria, per-sub-criterion evidence, per-dimension breakdown, and
  the flat `CandidateDimensionProfile` shape.
- **`dimension_scoring_agent/index.ts`**:
  - `assembleCandidateProfile()` — grounded strictly in existing tables
    (`candidates`, `candidate_academic_records`, `candidate_experience`,
    `candidate_quota`, `candidate_documents`); no phantom tables.
  - `scoreDimensions()` — pure, deterministic: reuses `applyOperator()`
    from the existing eligibility rule engine (one evaluation semantics
    system-wide); sub-criterion weights normalize to 100 within a
    dimension, dimension weights normalize to 100 across the active set;
    a knockout dimension below its threshold forces `AUTO_FAIL`
    regardless of overall score; any missing-field/low-confidence
    sub-criterion forces `NEEDS_REVIEW` instead of guessing.
  - `runDimensionScoring()` — orchestrates assemble → score → persist
    (single transaction) → audit.
- **`dimensions.routes.ts`**: `POST /configure` (Admin/Dept Head,
  zod-validated, weights must sum to 100, versions out the prior active
  set), `GET /configs`, `GET /templates` — all audited.
- **`evaluations.routes.ts`** extended: `POST /dimension-run` (Admin/
  Senior Recruiter; runs a batch of candidate IDs, per-candidate error
  isolation so one bad candidate doesn't fail the batch; audited).
- **`candidates.routes.ts`** extended: `GET /:id/dimension-scores` (full
  scoring history, evidence included), `PATCH
  /:id/dimension-scores/:evaluation_id` (Recruiter/Senior Recruiter;
  Approve/Reject/Override — override requires a mandatory reason, zod
  `.refine`-enforced; audited). This is the only path by which a
  dimension score is ever treated as final — the agent only suggests.
- **`server.ts`**: `dimensions.routes.ts` mounted at `/api/v1/dimensions`.
- **UI**: `hooks/hooks_dimensions.ts` (TanStack Query hooks matching the
  existing dev-token client pattern) and `components/DimensionScorecard.tsx`
  (overall fit score headline, per-dimension bar rows with click-to-expand
  sub-criteria evidence tables, Approve/Reject/Override controls with a
  mandatory-reason textarea for override) — follows the UROS color system
  (teal = agent/system, terracotta = human action, amber = attention) and
  the no-dead-space contract. Wired into `App.tsx` as a new "7-Dimension
  Matching" tab.
- **Tests, all passing in this environment**:
  `tests/unit/dimension_scoring_agent.test.ts` (9 cases: determinism,
  full-pass, failed-non-knockout, knockout → `AUTO_FAIL`, missing field →
  `NEEDS_REVIEW`, low confidence → `NEEDS_REVIEW`, weight normalization,
  inactive dimensions ignored), `tests/integration/dimensions.routes.test.ts`
  (8 cases: configure weight-sum validation, RBAC on configure and on
  patch, publish + audit, dimension-scores 404/200, override 400 without
  reason, override 404 unknown evaluation, override success + audit),
  `src/ui/src/components/DimensionScorecard.test.tsx` (5 smoke cases).
  Added `tests/jest.setup.ts` and `src/ui/tests/setup.ts` (the latter was
  referenced by `vite.config.ts` but had never been created).
- **Pre-existing bugs fixed to unblock compilation** (unrelated to
  Feature 1, minimal, behavior-preserving, required because they blocked
  `tsc`/`ts-jest` from compiling anything that transitively imports
  them): `operators.ts` — `EQ`/`NEQ`/`IN`/`NOT_IN` parameter type widened
  from `ComparableValue` to `unknown` to satisfy `OPERATOR_MAP`'s type
  (pre-existing TS2322); `credential_store.ts` — relative import depth
  was wrong (`../database/client` etc. instead of `../../database/client`),
  a pre-existing broken import that failed `tsc` entirely.
- **Verified in this environment**: `npm install` succeeded (backend and
  UI), `tsc --noEmit` clean on both, full Jest suite 17/17 passing, full
  Vitest suite 5/5 passing.
- No LLM, no black-box scoring anywhere in this feature. Deterministic,
  human-in-the-loop, fully audited, matches the rest of Phases 1–7.

---

---

## Feature 2 — Paper-Based MCQ Scanner ✅ Complete
(`UROS_Master_Feature_Documentation.md` Feature 2, Tier 2.) Additive on
top of Phases 1–7 and Feature 1 — no existing module modified except the
two pre-existing type/import bugs already documented under Feature 1.

- **Migration `0016_mcq_scanner.sql`**: 5 tables — `mcq_exams`,
  `mcq_answer_keys` (versioned, mirrors rule-pack versioning: a new
  `POST /mcq/configure` deactivates the prior version rather than
  mutating it), `mcq_answer_sheets` (one row per uploaded scanned page;
  `status` lifecycle `UPLOADED → PROCESSING → PROCESSED|NEEDS_REVIEW →
  CONFIRMED|REJECTED|RESCAN_REQUESTED`), `mcq_sheet_answers` (one row per
  detected question-answer — the evidence panel), `mcq_results` (one row
  per scored sheet, upserted on rescore). Two additive, documented
  extensions beyond the literal spec column list: `mcq_exams.answer_sheet_template`
  (JSONB; configurable roll/ID + per-question option zone layout,
  required for deterministic detection) and `mcq_exams.pass_threshold`
  (nullable; `mcq_results.passed` stays `NULL` until one is configured).
- **`mcq.model.ts`**: full TypeScript types for all 5 tables plus the
  detection/scoring intermediate shapes (`AnswerSheetTemplate`,
  `OptionDensityReading`, `QuestionDetectionResult`, `SheetDetectionResult`,
  `McqScoringOutput`).
- **`exam_scanner_agent/index.ts`**:
  - Preprocessing: `greyscale()` + `normalize()` + `contrast()` (real,
    deterministic Jimp pixel operations for shadow/lighting correction).
    Auto-rotate/de-skew are explicit, documented no-op hooks — a
    fiducial-marker-based implementation was out of scope, and blind
    rotation would be a guess, which UROS does not do.
  - Detection: unified **mark-density sampling** — a filled bubble, a
    ticked/crossed box, and a circled letter all raise the dark-pixel
    fraction inside that option's configured zone, so one deterministic
    method (`darkPixelFraction` + `pickBestReading`) covers all three
    mark styles without any model. Roll/ID detection samples the same
    way per digit column (0–9 boxes).
  - Ambiguity handling: no mark dark enough → `MISSING` (confident
    blank, no penalty, no review); top two marks too close together →
    `MULTIPLE_MARKS`; a single mark below the confidence separation
    threshold → `LOW_CONFIDENCE`. Both of the latter are scored as
    skipped and always flagged `NEEDS_REVIEW` — never guessed past.
  - `scoreSheet()` — pure, deterministic, unit-tested in isolation:
    marks_per_question × correct − negative_mark × wrong, skipped
    scored as neither; a question with no answer-key entry or no
    detection row is skipped and flagged rather than silently ignored;
    human `corrected_option` (once reviewed) takes precedence over
    `detected_option`.
  - `ingestSheetFile()` / `processSheet()` — orchestrates store → detect
    → persist `mcq_sheet_answers` → score → upsert `mcq_results` →
    update sheet status → audit, per sheet, inside a transaction. A
    single sheet's failure (unreadable file, missing template, storage
    error) never aborts the batch — it's recorded as `NEEDS_REVIEW` with
    `processing_error` set and audited as `MCQ_SHEET_PROCESSING_FAILED`.
  - `expandUpload()` — ZIP batches are expanded into individual
    JPG/PNG/PDF entries via `adm-zip`, each ingested as its own sheet.
    **PDF pages are stored but not rasterized** in this release (no
    poppler/PDF-to-image dependency was introduced) — a PDF upload is
    immediately flagged `NEEDS_REVIEW` with a clear `processing_error`
    telling the operator to upload JPG/PNG pages instead, rather than
    crashing or silently dropping the file.
- **`mcq.routes.ts`**: `POST /configure` (Admin/Dept Head; creates or
  reconfigures an exam + publishes a new answer-key version), `POST
  /upload` (Admin/Recruiter/Senior Recruiter; multer memory storage,
  50MB limit, field `file`, files written under
  `DOCUMENT_STORAGE_PATH/mcq/<org>/<exam>/`; processes synchronously
  since exam batches are dozens–low hundreds, not recruitment-scale
  volumes), `GET /results/:exam_id` (exam-level scorecard: every sheet's
  result + status counts), `GET /sheets/:sheet_id` (full evidence:
  sheet + per-question detections + result), `PATCH /sheets/:sheet_id`
  (Recruiter/Senior Recruiter/Admin; `CONFIRM` / `CORRECT` / `REJECT` /
  `RESCAN`, mandatory `reason` on every action zod-`.refine`-enforced,
  `CORRECT` rescales deterministically from human `corrected_option`
  values, fully audited). Mounted at `/api/v1/mcq` in `server.ts`.
- **UI**: `hooks/hooks_mcq.ts` (TanStack Query; upload uses raw
  `fetch`+`FormData` since the shared `authedRequest` helper is JSON-only)
  and `components/McqScannerPanel.tsx` — live status-count strip
  (Uploaded/Processing/Processed/Needs Review/Confirmed/Rejected/Rescan
  Requested, no dead space), results table with per-sheet Review action,
  CSV scorecard export, and a sheet detail view showing the original
  scanned image, a flagged-answers evidence table, per-question
  correction dropdowns, and Confirm/Apply Corrections/Reject/Request
  Rescan controls each requiring a reason before submission. Uses the
  existing UROS color tokens (teal = agent/processing, amber =
  needs-review/attention, terracotta = human action, red = rejected,
  green = processed/confirmed). Wired into `App.tsx` as a new "MCQ
  Scanner" tab.
- **Tests, all passing in this environment**:
  `tests/unit/mcq_scoring.test.ts` (10 cases: determinism, all-correct,
  negative marking, confident-blank vs. ambiguous skipped, human
  correction override, missing answer-key entry, pass/fail/unconfigured
  threshold, zero negative marking, missing detection row),
  `tests/integration/mcq.routes.test.ts` (12 cases: configure RBAC/
  validation/creation+audit, upload RBAC/404/400-no-file, upload of a
  **real** tiny PNG processed through the actual Jimp detection pipeline
  end-to-end resulting in a correctly-flagged `NEEDS_REVIEW` sheet,
  PATCH CONFIRM/CORRECT/404/RBAC/mandatory-reason), `McqScannerPanel.test.tsx`
  (4 smoke cases: empty state, results table + status strip, evidence
  drill-down, mandatory-reason gate on Confirm).
- **Environment fix required to run these tests**: Jimp v1 uses an
  internal dynamic `import()` for image-format detection, which Jest's
  default (non-ESM) VM blocks. Added `NODE_OPTIONS=--experimental-vm-modules`
  to the `test`/`test:unit`/`test:integration` npm scripts and to
  `tests/jest.setup.ts` a `DOCUMENT_STORAGE_PATH` default pointing at a
  writable temp path for the test environment. `exam_scanner_agent`'s
  own `fs`/`path` imports were also changed from dynamic `await
  import(...)` to static imports for the same reason.
- New dependencies added (pure JS / no native compilation):
  `jimp`, `multer`, `adm-zip` (+ `@types/multer`, `@types/adm-zip`).
- **Verified in this environment**: `tsc --noEmit` clean (backend + UI),
  full Jest suite 39/39 passing across all 4 backend suites (Feature 1 +
  Feature 2, unit + integration), full Vitest suite 9/9 passing across
  both UI components.
- No LLM, no black-box scoring, no external AI service. Deterministic
  mark-density detection, human-in-the-loop on every ambiguous or
  low-confidence result, fully audited, matches the rest of Phases 1–7
  and Feature 1.

---

---

## Feature 3 — Digital Exam Paper Creator ✅ Complete
(`UROS_Master_Feature_Documentation.md` Feature 3, Tier 3.) Additive on
top of Phases 1–7 and Features 1–2 — no existing module modified.

- **Migration `0017_digital_exam.sql`**: the 4 spec'd tables —
  `digital_exams`, `exam_sections`, `exam_questions`,
  `digital_exam_submissions` — plus two additive tables required to meet
  "Support version history and human approval gates" / "Maintain
  question bank and reuse past questions" from the Master Feature Doc:
  `exam_question_bank` (org-wide reusable questions, referenced by
  `exam_questions.bank_question_id`) and `digital_exam_versions`
  (full-paper JSONB snapshot taken on every publish, for rollback).
  Additive columns beyond the literal spec list, all documented inline
  in the migration: `digital_exams.version`/`persona_id`/`total_marks`/
  `approved_by`/`approved_at`/`updated_at`; `exam_sections.topic`/
  `weight` (guided builder's topic/weight inputs); `exam_questions.source`/
  `bank_question_id` (provenance: MANUAL/QUESTION_BANK/PARSED);
  `digital_exam_submissions.needs_review`/`reason_code`/
  `reason_description`/`score_breakdown`/`graded_by`/`graded_at`.
- **`digital_exam.model.ts`**: full TypeScript types, including the
  global reasoning contract types `QuestionReasonCode`,
  `SubmissionReasonCode`, `QuestionEvidence`, and `QuestionScoreEvidence`
  (reason_code + reason_description + structured evidence on every
  scored question — see "Global reasoning requirement" below).
- **`digital_exam_agent/index.ts`**:
  - `assembleExamPaper()` — deterministic section/question ordering
    (`order_index ASC`); `includeAnswers=false` strips `correct_answer`
    for candidate-facing exports/links (APPLICANT role never sees
    answers via `GET /exams/:exam_id` either).
  - `scoreSubmission()` — pure, deterministic, unit-tested in isolation.
    MCQ: exact case-insensitive match against `correct_answer`, marks/
    negative-marking applied, every outcome (`CORRECT`/`WRONG`/`SKIPPED`)
    carries a `reason_code`, plain-language `reason_description`, and a
    `QuestionEvidence` object (question text, submitted answer, correct
    answer, marks available, negative mark, rule applied).
    SHORT_ANSWER: **never auto-graded** — free-text grading would
    require a model, which this feature does not use; every
    short-answer question is `PENDING_MANUAL_GRADE` and forces the
    submission's `needs_review=true`, `reason_code=
    PENDING_MANUAL_GRADE_SHORT_ANSWER_PRESENT`.
  - `gradeShortAnswer()` — human grading of one short-answer question;
    mandatory `reason`, clamps awarded marks to `[0, marks_available]`,
    recomputes the submission total from the full breakdown, flips
    status to `GRADED` once no question remains `PENDING_MANUAL_GRADE`,
    fully audited with `reason_code=SHORT_ANSWER_MANUALLY_GRADED`.
  - `publishExam()` — the mandatory human approval gate: refuses to
    publish an exam with no questions; snapshots the full assembled
    paper into `digital_exam_versions` and flips `status=PUBLISHED`,
    audited with `reason_code=EXAM_PUBLISHED_HUMAN_APPROVAL`.
  - `parseUploadedExamPaper()` / `parseExamPaperText()` — deterministic,
    regex-based paper parsing, no ML/LLM (BYOK: no external AI service).
    `.docx` gets real text extraction (a `.docx` is a ZIP of XML;
    `word/document.xml` is pulled via `adm-zip` and tags stripped —
    reuses the dependency installed for Feature 2). Scanned images are
    OCR'd with `tesseract.js`, the same library `parser_agent` already
    uses. `.txt` is read directly. **PDF parsing is not implemented in
    this release** — same documented, honest limitation as the MCQ
    Scanner's PDF handling: a PDF upload returns a clear error
    (`error: "PDF exam paper parsing is not implemented..."`) instead of
    guessing. An MCQ with no recognized `Answer:` line is parsed with
    `confidence: "Low"` and `correct_answer: null` rather than guessed —
    always routed to human review in the builder before publish.
  - `exportExamPaper()` — deterministic document generation via
    `pdfkit` (pdf/interactive_pdf — the "interactive" distinction is a
    documented gap: this release produces the same faithful static
    rendering for both rather than fillable form fields) and `docx`
    (npm package) for Word export; `link` format does no rendering at
    all, returning a stable `{APP_PUBLIC_URL}/exams/:id/take` URL for
    the Communication Hub to share.
- **New env var**: `APP_PUBLIC_URL` (default `http://localhost:3000`) —
  base URL used to build the shareable digital exam link.
- **`exams.routes.ts`**: the 6 spec'd routes — `POST /exams` (create/
  full-replace of a DRAFT's sections+questions; refuses to edit a
  PUBLISHED exam), `GET /exams/:exam_id`, `POST /exams/:exam_id/submit`,
  `POST /exams/:exam_id/score`, `GET /exams/:exam_id/results`,
  `GET /exams/:exam_id/export?format=pdf|docx|interactive_pdf|link` —
  plus additive routes needed to actually reach the agent capabilities
  requirement #3 asked for: `POST /exams/parse` (upload .docx/image/.txt,
  returns drafts for review, persists nothing), `POST
  /exams/:exam_id/publish` (the human approval gate), `PATCH
  /exams/:exam_id/submissions/:submission_id/grade` (mandatory-reason
  short-answer grading), `GET /exams` (org exam list), `GET
  /exams/question-bank` (reusable bank). All zod-validated, RBAC'd
  (Admin/Dept Head for authoring+publish+parse; Recruiter/Senior
  Recruiter/Admin for grading; Admin/Senior Recruiter for triggering
  score), fully audited. Mounted at `/api/v1/exams` in `server.ts`.
- **Global reasoning requirement retrofitted across the whole feature**
  (per explicit instruction mid-build): every stored/returned result —
  `DigitalExamScoringOutput`, every `QuestionScoreEvidence`, every
  `digital_exam_submissions` row, every publish/export/grade audit
  entry — carries a `reason_code`, a plain-language `reason_description`,
  and structured `evidence` (question text, candidate answer, correct
  answer, marks, rule applied). `AuditLogEntry.reason_code`/
  `reason_comment` (already present on the audit model from earlier
  phases) are now populated on every Feature 3 audit call: create,
  update, publish, parse, submit, score, grade, export. No Feature 3
  result can be stored or displayed without this.
- **UI**: `hooks/hooks_exams.ts` (TanStack Query, matching the existing
  client pattern; upload/export use raw `fetch` since they're
  multipart/binary) and `components/DigitalExamBuilder.tsx` — guided
  flow (pick/choose persona → per-section topic+weight inputs → live
  preview that updates as you type), native HTML5 drag-and-drop
  reordering for both sections and questions (no new dependency), inline
  question editor (MCQ options + correct-answer radio, or short-answer),
  "Upload & Parse Paper" merging deterministic drafts into a new
  "Imported Questions" section (source=PARSED, visibly labeled),
  Save/Publish/Export PDF/Export DOCX/Export Interactive PDF/Copy
  Digital Link actions, and a Submissions & Results panel where **every
  result row has a "Why?" link** that expands to show `reason_code`,
  `reason_description`, and the full per-question evidence table
  (candidate answer / correct answer / marks / rule applied) — including
  an inline mandatory-reason grading control for pending short-answer
  questions. Uses the existing UROS color tokens throughout. Wired into
  `App.tsx` as a new "Digital Exam Creator" tab.
- New dependencies added (pure JS / no native compilation): `pdfkit`,
  `docx` (+ `@types/pdfkit`).
- **Tests, all passing in this environment**:
  `tests/unit/digital_exam_scoring.test.ts` (15 cases: determinism,
  correct/wrong/skipped MCQ with reason_code+evidence assertions,
  short-answer never-auto-graded + needs_review, mixed MCQ+short-answer
  paper, case-insensitive matching, zero negative marking, multi-question
  summation, and 4 deterministic-parser cases including the
  Low-confidence-on-no-answer-key and short-answer-fallback rules),
  `tests/integration/exams.routes.test.ts` (5 cases including a full
  lifecycle test — create → get paper → publish → submit → score →
  results → grade → export pdf/docx/link — run against a stateful
  in-memory fake DB with **real** `pdfkit`/`docx` document generation,
  no mocking of the render step), `DigitalExamBuilder.test.tsx`
  (4 smoke cases: renders guided builder, add section/question reflected
  in live preview, Create-Exam button gating, Why? link revealing
  reason_code/evidence on a submission).
- **Verified in this environment**: `tsc --noEmit` clean (backend + UI),
  full Jest suite 56/56 passing across 6 backend suites (Features 1–3,
  unit + integration), full Vitest suite 13/13 passing across all 3 UI
  components.
- No LLM, no black-box scoring, no external AI service anywhere in this
  feature. Deterministic MCQ auto-scoring, deterministic regex-based
  paper parsing, human-in-the-loop on every short-answer grade and every
  publish, fully audited with reason_code/reason_description/evidence on
  every result, matching the rest of Phases 1–7 and Features 1–2.

---

---

## Feature 4 — Applicant Status Portal ✅ Complete
(`UROS_Master_Feature_Documentation.md` Feature 4, Tier 1.) Additive,
read-only, and public-facing — deliberately separate from the internal
staff dashboard. No existing module modified.

- **Migration `0018_applicant_portal.sql`**: 2 tables, the minimum
  necessary per the explicit "no new migration unless absolutely
  necessary for portal access tokens or audit" instruction —
  `applicant_otp_requests` (short-lived, hashed OTP login codes; the
  plaintext code is **never** persisted or logged) and
  `applicant_portal_configs` (per-org visibility/localization settings —
  `visible_reason_codes` allowlist, `estimated_timeline_text`,
  `appeal_enabled`, `localized_messages`, `default_language`).
- **`applicant_portal.model.ts`**: full types, including the Global
  Reasoning Standard contract (`ApplicantReasonEntry` with
  `reason_code`/`reason_description`/`evidence`, and a top-level
  `reason_code`/`reason_description` on `ApplicantStatusView` itself —
  even the assigned stage/pill is explained, not just failures).
- **`applicant_portal_agent/index.ts`**:
  - **OTP auth, reusing the existing auth system rather than inventing a
    new one**: `requestApplicantOtp()` generates a 6-digit code, stores
    only `sha256(candidate_id:code:JWT_SECRET)`, and "delivers" it via
    the existing Communication Hub's `communication_log` table — the
    exact mechanism `communication_agent.sendBatch` already uses, no new
    send path. Always responds `{requested:true}` even for an unknown
    `candidate_id`, so the public endpoint never confirms/denies which
    application IDs exist. `verifyApplicantOtp()` checks expiry and a
    capped attempt counter, and on success issues a **standard UROS
    JWT** (`role=APPLICANT`, `user_id=candidate_id`) via the same
    `jsonwebtoken`/`JWT_SECRET` every other route already trusts — so
    `GET /portal/status` is protected by the exact same
    `authenticate`/`rbac("APPLICANT")` middleware as every internal
    route, with zero new auth code paths. Every OTP outcome (issued,
    verify failed — not-found/expired/max-attempts/mismatch, login
    success) is audited with a `reason_code`; the code itself is never
    logged anywhere.
  - `describeRuleOutcome()` — deterministic, template-based
    `reason_description` synthesis (no LLM): the Phase 1–2 eligibility
    engine's `rules` table has `field_path`/`operator`/`threshold_value`
    but no free-text description column, and per "do not rebuild
    existing modules" that schema was left untouched. Instead the
    portal composes a plain-language sentence from those existing,
    already-visible fields at read time — a pure string template, fully
    auditable and reproducible, not a generated summary.
  - `filterReasonsByVisibility()` — the org-configurable reason-code
    visibility policy, extracted as an independently unit-tested pure
    function: PASS rows are never shown (nothing to explain); a `null`
    allowlist (the default) shows every other reason for full
    transparency per `UROS_08_Trust_Fairness_Transparency.md`; a
    non-null allowlist restricts to exactly those codes.
  - `getApplicantStatusView()` — the read-only assembler: deterministic
    `candidates.status` → stage-label/pill mapping, filtered+described
    reasons (joins `evaluation_results` → `rules`), an evidence-documents
    summary from `candidate_documents` (assumption, documented here:
    the schema has no per-rule document linkage, so all of the
    candidate's documents are shown as "considered," not just ones tied
    to a specific failed rule), localized timeline/next-update text, and
    the org's appeal toggle. Every view is audited
    (`APPLICANT_STATUS_VIEWED`).
  - `upsertPortalConfig()` — org admin configuration, versionless
    upsert (config is a live setting, not a scored/published artifact —
    no version-history table was added here, unlike Features 1–3's
    scoring configs), fully audited.
- **`applicant_portal.routes.ts`**, mounted at `/api/v1/portal` in
  `server.ts` as a **separate router from every internal dashboard
  route** (no route in this file requires a staff JWT): `POST
  /otp/request` and `POST /otp/verify` (public, rate-limited 5/min and
  10/min respectively), `GET /status` (APPLICANT-only, scoped strictly
  to the token's own `candidate_id` — there is no `candidate_id`
  parameter anywhere on this route, so an applicant cannot view anyone
  else's application by construction), `GET`/`POST /admin/config`
  (Admin/Dept Head, Auditor read-only). **Appeals reuse the existing
  `POST /api/v1/appeals` endpoint directly** — no new appeal route was
  added, per the explicit "wire to existing appeals route if available"
  instruction; the portal UI's appeal form calls it with the applicant's
  own OTP session token.
- **New env var**: `APPLICANT_OTP_EXPIRY_MINUTES` (default `10`).
- **UI**: `hooks/hooks_applicant_portal.ts` (deliberately independent of
  `api/client.ts`'s staff dev-token — the applicant's OTP session is
  stored under its own `sessionStorage` key so it can never collide with
  or be confused for a staff session in the same browser) and
  `components/ApplicantStatusPortal.tsx` — calm off-white login screen
  (Candidate ID + channel → 6-digit code), then a status screen with a
  colored status pill (green/amber/red/neutral matching
  `UROS_Color_System.md`), a top-level "Why?" link for the stage itself,
  a "Why?" link per reason entry revealing `reason_code` +
  `reason_description` + the full evidence table (rule applied, your
  submitted value, confidence, evaluated-at), a Documents Considered
  list, an always-populated "What happens next" panel (never a dead
  end), and an appeal button (hidden when the org disables it) that
  opens a mandatory-reason form. **Wired as a genuinely separate
  surface**: `main.tsx` renders `ApplicantStatusPortal` instead of the
  internal `App` when the path is `/portal` — no CommandBar, no
  AuditStream, no dev-token requirement, zero new npm dependencies
  (plain `window.location.pathname` check, not a router library).
- **Tests, all passing in this environment**:
  `tests/unit/applicant_portal.test.ts` (12 cases: `filterReasonsByVisibility`
  determinism/PASS-exclusion/null-shows-all/allowlist-restriction/empty-allowlist,
  `describeRuleOutcome` determinism and FAIL/NEEDS_REVIEW/PASS phrasing,
  array-threshold formatting, unknown-operator fallback),
  `tests/integration/applicant_portal.routes.test.ts` (7 cases against a
  stateful in-memory fake DB with a real `crypto.randomInt` mock: no
  candidate-ID enumeration on OTP request, full request→verify→status
  lifecycle scoped strictly to the token, max-attempts lockout, RBAC on
  `/status` and `/admin/config`, org visible-reason-codes filtering
  end-to-end, and a 404 when a forged token's org doesn't match the
  candidate's actual org), `ApplicantStatusPortal.test.tsx` (5 smoke
  cases: login screen, OTP-request→verify-step transition, status
  screen rendering, Why? evidence expansion, mandatory-reason appeal
  submission).
- **Verified in this environment**: `tsc --noEmit` clean (backend + UI),
  full Jest suite 75/75 passing across 8 backend suites (Features 1–4,
  unit + integration), full Vitest suite 18/18 passing across all 4 UI
  components.
- Follows `UROS_Global_Reasoning_Standard.md` strictly: every reason
  shown to an applicant carries `reason_code` + `reason_description` +
  structured `evidence`; every OTP/status/config action has a
  corresponding `audit_log` entry; the UI's "Why?" link is present on
  every result panel, exactly as required. No LLM, no black-box scoring
  — the portal only presents deterministic data other agents already
  computed, human-in-the-loop preserved (appeals still route to a human
  reviewer via the existing appeals workflow).

---

---

## Core Agent Stubs Fixed — Eligibility, Report, Audit Agents ✅ Complete
A technical review found three agent folders (`src/agents/eligibility_agent/`,
`src/agents/report_agent/`, `src/agents/audit_agent/`) that had shipped
since Phase 1 containing only a `.gitkeep` placeholder — their actual
logic was inline in other modules instead. All three are now real,
independently testable modules; the modules that used to hold that
inline logic (`services/orchestrator/pipeline.ts`,
`api/routes/reports.routes.ts`, `api/routes/audit.routes.ts`) were
refactored to call them instead of duplicating the logic, with **zero
behavior change** for pipeline.ts and audit.routes.ts, and a genuine
capability upgrade for reports.routes.ts (pdf/excel/csv actually render
now instead of returning a 202 "not implemented" stub).

- **`eligibility_agent/index.ts`** — `runEligibility(candidate,
  rulePackVersionId)`: loads the active `ELIGIBILITY` rules for a rule
  pack version and evaluates the candidate against each by calling the
  existing `evaluateRule()` (`src/rules/engine/evaluator.ts`) — no new
  evaluation semantics, only orchestration/aggregation. Deterministic
  aggregation exactly matching the logic that used to live inline in
  `pipeline.ts`'s `stageEligibility`: a knockout `FAIL` short-circuits
  remaining rules; any `FAIL` sets the aggregate to `FAIL` (but
  non-knockout `FAIL`s don't stop evaluating the rest, so every rule
  still contributes evidence); any `NEEDS_REVIEW` sets the aggregate to
  `NEEDS_REVIEW` unless a `FAIL` has already been recorded (`FAIL`
  always wins); otherwise `PASS`. `evaluateRule()` already persists each
  per-rule outcome to `evaluation_results` + an audit_log
  `RULE_EVALUATED` entry; `runEligibility` additionally logs one summary
  `ELIGIBILITY_RECOMMENDATION_COMPUTED` audit entry per candidate so the
  aggregate itself is independently auditable. **Recommendation only**:
  never writes `candidates.status`, never enqueues a HIL review — the
  orchestrator/HIL Supervisor still owns those decisions, matching "no
  final decision, only recommendation." Also adds
  `runEligibilityForCircular()`, a batch convenience wrapper where one
  candidate's evaluation exception never aborts the rest of the batch.
  `pipeline.ts`'s `stageEligibility` now calls `runEligibility` per
  candidate instead of its previous inline per-rule loop — identical
  resulting behavior (status transitions, HIL enqueueing), single
  source of truth for the aggregation rule going forward.
- **`report_agent/index.ts`** — `getFunnelData`, `getShortlistSummary`,
  `getVerificationStatus` (the exact three live queries
  `reports.routes.ts` used to run inline for its JSON-only path) plus a
  new `getAuditLogsReport` (delegates to the Audit Agent, no duplicate
  query), all unified behind `getReportRows(type, circularId)` so every
  export format renders from identical data. Real, deterministic
  binary rendering — no ML/LLM — via `renderCsv` (pure, RFC4180
  quoting), `renderPdf` (`pdfkit`, reusing the tabular-rendering
  approach already established in `digital_exam_agent`), and
  `renderExcel` (`exceljs`, newly installed — pure JS, no native
  compilation). `generateReport(type, circularId, format, actor)` is
  the single orchestration entry point and always logs
  `REPORT_GENERATED` to audit_log. `reports.routes.ts`'s `GET
  /reports/generate` now actually returns working PDF/Excel/CSV files
  (previously always responded `202 QUEUED ... not implemented` for
  those three formats) and gained a fourth report type, `AUDIT_LOGS`.
- **`audit_agent/index.ts`** — **read/validate only, by design; never
  writes** (writing remains exclusively `utils/audit_helper.ts`'s
  `logAudit()`, called directly by every other agent/route exactly as
  before — this agent introduces no second write path).
  `fetchAuditTrail(filters)` is the exact parameterized filter-building
  query `audit.routes.ts` used to run inline, extracted so the route is
  now a genuinely thin wrapper. `fetchEntityHistory(entityType,
  entityId)` is a convenience oldest-first view for a single entity.
  `checkAuditConsistency(candidateId?)` is the optional health check:
  a single set-based `NOT EXISTS` query (not a per-row N+1 loop) cross-
  checking `evaluation_results` against `audit_log` for a
  `RULE_EVALUATED` entry at or after each evaluation's `evaluated_at` —
  surfaces the specific `evaluation_id`s missing a corresponding audit
  entry rather than just a pass/fail boolean. Exposed at a new read-only
  `GET /api/v1/audit-logs/consistency-check` endpoint (Admin/Auditor).
- New dependency added (pure JS / no native compilation): `exceljs`.
- **Tests, all passing in this environment**:
  `tests/unit/eligibility_agent.test.ts` (9 cases: all-PASS, non-knockout
  FAIL evaluates all rules, knockout FAIL short-circuits, NEEDS_REVIEW
  aggregation, FAIL-precedence-over-NEEDS_REVIEW regardless of order,
  determinism, confirms no `candidates` UPDATE is ever issued — the
  recommendation-only contract — summary audit logging, and the batch
  wrapper's per-candidate failure isolation), `tests/unit/report_agent.test.ts`
  (9 cases: CSV determinism/header-row/RFC4180 quoting/null-handling/
  empty-input, real PDF generation producing valid `%PDF-` output for
  both populated and empty reports, real Excel generation round-tripped
  through `exceljs` to confirm header + data rows), `tests/unit/audit_agent.test.ts`
  (10 cases: filter-clause construction is fully parameterized for
  every filter combination, limit/offset clamping, entity-history
  ordering, consistency-check consistent/inconsistent scenarios,
  explicit assertion that every SQL statement issued is a `SELECT` —
  the read-only contract — and the system-wide/no-candidate-scope path),
  `tests/integration/core_agents.routes.test.ts` (10 cases against the
  refactored `reports.routes.ts`/`audit.routes.ts`: JSON/CSV/PDF/Excel
  report generation with real file output and `REPORT_GENERATED`
  auditing, the new `AUDIT_LOGS` report type, RBAC on both routes, and
  the new consistency-check endpoint).
- **Verified in this environment**: `tsc --noEmit` clean, full Jest
  suite **112/112 passing across 12 backend suites** (all of Features
  1–4 plus these three core-agent suites, confirming the
  `pipeline.ts`/`reports.routes.ts`/`audit.routes.ts` refactors
  introduced zero regressions), full Vitest suite 18/18 passing
  (UI untouched this round).
- No LLM, no black-box logic anywhere in these three agents.
  Deterministic rule evaluation and report rendering, human-in-the-loop
  preserved (eligibility recommends only), full audit coverage, and the
  audit trail itself is now independently verifiable rather than merely
  trusted.

---

## Phase 8 — Planned: Brain Studio & Remaining Dashboard Surfaces
- Brain Studio (visual rule builder UI, per `UI_UX_Brain_Panel.md`)
- Verification Center, Reports UI, BYOK/Provider Settings UI (surfacing
  the Phase 5 credentials API), employee/onboarding search & picker UX
- Login flow replacing the dev-token affordance; real funnel/stats endpoint
- Redis-backed shared rate limiter (if horizontally scaled); `email`
  connector IMAP/Gmail transport; `scripts/seed_test_data.ts`

---

## Feature 5 — Complete: Multi-Language Interface and Document Support (English / বাংলা)

- **Migration** `0019_multilang.sql`: `organizations.default_language`
  (default `'en'`), `users.preferred_language`, `candidates.preferred_language`
  (needed so the communication-template resolver can honor a candidate's
  own preference, not just an org-wide default — see
  `UROS_Product_Roadmap_Feature_Expansion_Updated.md` Feature 5 spec),
  and `communication_log.language` (records which variant was actually
  sent, as evidence). All four columns `CHECK`-constrained to `('en','bn')`.
  Models (`organization.model.ts`, `user.model.ts`, `candidate.model.ts`)
  updated to match.
- **Backend i18n**: `src/i18n/{en,bn}.json` — real, hand-authored
  dictionaries (not stubs); `src/services/i18n/translations.ts` —
  deterministic loader, always backfills missing non-English keys from
  English rather than omitting them; `GET /api/v1/i18n/translations?lang=en|bn`
  (public — both the dashboard's pre-login shell and the portal's login
  screen need labels before any JWT exists); `PATCH /api/v1/users/me/language`
  (staff roles only — an APPLICANT JWT's `user_id` is a candidate_id with
  no row in `users`); `PATCH /api/v1/organizations/language` (ADMIN only);
  `PATCH /api/v1/portal/preferences` added to the existing Applicant
  Portal router for a candidate's own preference. All three mutating
  routes are zod-validated, RBAC-guarded, and fully audited (including
  the previous value as before/after evidence on the org route).
- **Communication templates**: `src/services/communication/template_language_resolver.ts`
  — pure, deterministic `resolveTemplateLanguage()` implementing the
  precedence candidate.preferred_language → organization.default_language
  → `'en'`, with a `TEMPLATE_LANGUAGE_VARIANTS` registry (data, not
  inference) and full `reason_code`/`reason_description` output per
  `UROS_Global_Reasoning_Standard.md`. `communication_agent.sendBatch()`
  rewritten to use it, record the resolved language on
  `communication_log`, and audit every resolution. Also fixed a
  pre-existing bug in `communications.routes.ts` where the validated
  `channel` field was never actually passed to `sendBatch` (always sent
  as hardcoded `'SMS'`).
- **Bangla OCR** (`parser_agent`): new `OcrLanguage` type
  (`"eng" | "ben" | "eng+ben"`), `TESSERACT_LANG_PATH` env var so
  traineddata can be loaded from a local directory instead of
  tesseract.js's default CDN fetch — required for air-gapped/on-prem
  deployments (`10_Technical_Architecture.md` §9). Bangla digit
  normalization (০-৯ → 0-9) and Bangla label/division regex extraction
  run only as a fallback when the existing English patterns find
  nothing, so English-only documents parse identically to before. Every
  OCR failure (including a missing `ben.traineddata` pack) is audited
  with a distinct `reason_code` and routes the candidate to
  `NEEDS_REVIEW` via the existing zero-confidence path — never silently
  accepted.
- **UI**: `src/ui/src/i18n.tsx` (context/hook — renders synchronously
  from a bundled dictionary so the UI is never blank, then overlays the
  server dictionary once fetched; deliberately independent of
  react-query so it needs no ambient `QueryClientProvider`);
  `src/ui/src/components/LanguageSwitcher.tsx` (always-visible two-way
  toggle, existing color tokens); wired into `CommandBar.tsx` (labels
  translated; language choice best-effort persisted via
  `PATCH /users/me/language` when a dev token is present) and
  `ApplicantStatusPortal.tsx` (labels translated, exact original English
  wording preserved so the pre-existing test file needed no changes;
  self-wraps in its own `<I18nProvider>`; persists via
  `PATCH /portal/preferences` when an applicant session exists). Fixed a
  real bug caught while wiring this up: the appeal-category `<select>`
  was about to submit the *translated* label as the category value —
  now uses stable English `value=` attributes with only the visible
  label translated.
- Also discovered and restored `src/ui/tests/setup.ts`, which
  `vite.config.ts` already referenced but was absent from this
  environment — required for any Vitest run (including the four
  pre-existing UI test files) to execute at all.
- **Tests, all passing in this environment**:
  `tests/unit/template_language_resolver.test.ts` (8 cases: candidate
  match, org fallback with/without a candidate preference, fallback to
  `'en'` when a variant is missing, unregistered template code, invalid
  language values, determinism, and every registered template having an
  `'en'` variant), `tests/unit/translations.test.ts` (6 cases, including
  that the Bangla dictionary is a real distinct translation and not a
  copy of English), `tests/unit/parser_agent_bangla_ocr.test.ts` (6
  cases: English regression, Bangla label extraction, Bangla digit
  normalization, low-confidence flagging, unavailable-language-pack
  failure handling with audit assertion, combined `eng+ben` model),
  `tests/integration/i18n_language_routes.test.ts` (13 cases covering
  both translation endpoints and both language-preference PATCH routes,
  including RBAC and 404 paths) — **backend: 4 suites / 33 tests, all
  passing**. UI: `src/ui/src/components/LanguageSwitcher.test.tsx` (5
  cases: renders both options, switches + persists to localStorage,
  fires `onLanguageChange`, no-op on re-clicking the active language,
  and a consuming component's text actually updates on switch) —
  **UI: 5 suites / 23 tests, all passing** (the four pre-existing suites
  are unmodified and still pass unchanged).
- **Verified in this environment**: backend `tsc --noEmit` clean, UI
  `tsc -p tsconfig.json` clean, `npm test` (backend) 33/33, `npx vitest run`
  (UI) 23/23.
- No LLM, no black-box logic: every translation is static, human-authored,
  versioned JSON; every template-language and OCR-language decision is a
  pure deterministic function with a `reason_code` + `reason_description`
  + audit_log entry. Human-in-the-loop preserved throughout (OCR
  failures and low-confidence Bangla extractions still route to
  `NEEDS_REVIEW`, never an automatic decision).

---

## Feature 6 — Fraud & Inconsistency Detection ✅ Complete
(`UROS_Master_Feature_Documentation.md` Feature 6, Tier 2.) Additive on
top of Phases 1–7 and Features 1–5 — no existing module modified except
two pre-existing test-infrastructure gaps fixed to unblock this feature
(see below).

- **Migration `0020_fraud_detection.sql`**: the 2 spec'd tables —
  `fraud_checks` (`check_id`, `org_id`, `name`, `check_type`, `config`
  JSONB, `active`, `created_by`, `created_at`, plus an additive
  `is_knockout` flag: metadata only, surfaced to reviewers so they know
  a *confirmed* flag on that check is meant to be disqualifying — the
  agent itself never writes `candidates.status`, matching the
  "recommendation only" contract already established by
  `eligibility_agent`/`dimension_scoring_agent`) and `fraud_flags`
  (`flag_id`, `candidate_id`, `check_id`, `severity`, `reason_code`,
  `reason_description`, `evidence` JSONB, `status`, `detected_at`,
  `reviewed_by`, `reviewed_at`, `resolution`, `resolution_reason`, plus
  an additive `org_id` for direct RBAC scoping without a join). A
  partial unique index (`org_id, check_type WHERE active`) enforces
  exactly one active configuration per check type, versioned the same
  way as `dimension_configs`. Also adds three partial indexes on
  `candidates(org_id, national_id/phone_primary/lower(email))` — needed
  for the duplicate-identity check to stay a targeted lookup instead of
  a full scan at 100K+ candidates per org; this is the only change to
  an existing table, and it's additive (index only).
- **`fraud.model.ts`**: full types for both tables, the 5
  `FraudCheckType`s, per-check-type config shapes
  (`AgeEducationTimelineConfig`, `CgpaDivisionConsistencyConfig`,
  `ExperienceOverlapConfig`, `DuplicateIdentityConfig`,
  `ImpossibleDobGraduationConfig`), the flat `FraudCandidateProfile`
  assembled from existing tables, and `FraudCheckOutcome` — the Global
  Reasoning Standard contract (`reason_code`/`reason_description`/
  `evidence`) attached to every check result, PASS included.
- **`fraud_detection_agent/index.ts`** — five pure, deterministic,
  independently unit-tested check functions, each returning
  PASS/FAIL/NEEDS_REVIEW with full reasoning:
  - `checkAgeEducationTimeline` — age-at-passing-year against a
    per-level configurable minimum, plus ascending-year-gap validation
    across SSC→HSC→Bachelor→Masters. Missing DOB → `NEEDS_REVIEW`
    (never guessed); no dated academic records → `PASS`
    (not-applicable, not silently skipped without a reason).
  - `checkCgpaDivisionConsistency` — compares a record's stated
    division/class against the division implied by its CGPA + scale
    (4.0 or 5.0 scale, illustrative default thresholds, fully
    org-overridable). `division_class='CGPA'` (no separate label) or an
    unrecognized `result_scale` → not a guessed mismatch, `PASS
    (not applicable)`/`NEEDS_REVIEW (scale unknown)` respectively.
  - `checkExperienceOverlap` — pairwise date-range overlap across every
    experience entry; overlap beyond a configurable allowance (default
    30 days) → `FAIL`, a smaller overlap → `NEEDS_REVIEW` (legitimate
    part-time/concurrent roles happen), no overlap → `PASS`.
  - `checkDuplicateIdentity` — case-insensitive match on national ID,
    primary phone, and/or email against other candidates in the same
    org (the actual DB lookup is a separate, targeted, indexed query —
    this function itself is pure given a candidate list, for
    testability).
  - `checkImpossibleDobGraduation` — DOB not in the future, age within
    a configurable plausible maximum (default 80 years), and no
    academic record's passing year at or before the birth year.
  - `buildEffectiveChecks()` — merges an org's explicit `fraud_checks`
    rows with `DEFAULT_CHECK_CONFIGS` for any unconfigured check type,
    so fraud detection runs correctly out of the box with zero setup,
    while remaining fully overridable per org; an org can also
    explicitly disable a check type entirely (deactivate with no
    replacement).
  - `runFraudChecks()` — the pure orchestration core: given a profile,
    other-candidate list, and effective check set, runs all five and
    returns every outcome (including PASS) — no I/O, fully
    unit-testable.
  - `assembleFraudProfile()` / `findMatchingOtherCandidates()` /
    `runFraudDetectionForCandidate()` / `runFraudDetectionBatch()` — the
    I/O layer: assembles the profile from `candidates` +
    `candidate_academic_records` + `candidate_experience` (existing
    tables, no phantom schema), runs a targeted indexed query for
    duplicate-identity candidates (never a full-table scan), persists a
    `fraud_flags` row for every non-PASS outcome inside a transaction,
    and **audits every outcome including PASS** — the Global Reasoning
    Standard's "no result may exist without reasoning" applies to clean
    results too, not only failures. `runFraudDetectionBatch()` gives
    per-candidate error isolation: one candidate's missing row or bad
    data is captured on that candidate's result and never aborts the
    rest of the batch.
- **`fraud.routes.ts`**: `POST /fraud/configure` (Admin/Dept Head,
  zod-validated `check_type` enum, versions out the prior active row
  for that type, audited), `GET /fraud/checks` (any staff role; always
  returns all 5 check types, merging in system defaults so the UI is
  never empty even before any org configures anything), `POST
  /fraud/run` (Admin/Recruiter/Senior Recruiter/System Agent; accepts
  either an explicit `candidate_ids` list or a `circular_id` to run an
  entire batch, capped at 500 per call — mirrors the existing `POST
  /evaluations/dimension-run` batch-size convention rather than
  introducing new queue infrastructure for this feature; page through
  larger circulars with repeated calls), `GET
  /fraud/flags/:candidate_id` (full flag history, most recent first,
  org-scoped, 404 if the candidate isn't in the caller's org), `PATCH
  /fraud/flags/:flag_id` (Admin/Recruiter/Senior Recruiter; resolution
  is `CONFIRMED`/`FALSE_POSITIVE`/`ESCALATED`, `resolution_reason` is
  zod-mandatory regardless of which resolution is chosen — not only for
  overrides — fully audited). This PATCH is the only path by which a
  fraud flag is ever treated as resolved; the agent only ever suggests.
  Mounted at `/api/v1/fraud` in `server.ts`.
- **UI**: `hooks/hooks_fraud.ts` (TanStack Query, matching the existing
  dev-token client pattern) and `components/FraudDetectionPanel.tsx` —
  an always-populated active-checks grid (system defaults shown as
  such, knockout checks badged), a run-detection form (candidate IDs or
  a whole circular ID), a run-results table showing flags-created count
  per candidate with a "Review Flags" action, and a per-candidate flag
  list with severity/status badges, a "Why? (evidence)" expandable
  panel showing the exact stored evidence JSON, and human
  Confirm/False-Positive/Escalate controls each gated on a mandatory
  reason textarea (mirrors the `McqScannerPanel`/`DimensionScorecard`
  mandatory-reason pattern). Uses the existing UROS color tokens
  throughout (teal = agent, amber = attention/medium severity, terracotta
  = human action, red = high severity/confirmed). Wired into `App.tsx`
  as a new "Fraud Detection" tab.
- **Pre-existing test-infrastructure gaps fixed to unblock this feature**
  (both referenced by existing config files but absent from this
  environment's snapshot, exactly like the Feature 1 `operators.ts`/
  `credential_store.ts` import-depth fixes): `src/ui/tests/setup.ts`
  (imports `@testing-library/jest-dom`; referenced by `vite.config.ts`'s
  `setupFiles` and `tsconfig.json`'s `include`, but missing — without it
  every existing UI test file failed `tsc` with "`toBeInTheDocument`
  does not exist" across all 5 pre-existing component test files, not
  just this feature's new one) and `tests/jest.setup.ts` (referenced by
  `jest.config.js`'s `setupFiles`; sets placeholder-but-valid
  `DATABASE_URL`/`JWT_SECRET`/`ENCRYPTION_KEY`/`DOCUMENT_STORAGE_PATH`
  env vars so any test importing `config/env.schema.ts` doesn't
  `process.exit(1)` before running). Neither existed as a `tests/`
  directory at all in this snapshot; both are minimal, behavior-neutral
  restorations of what the config files already assumed.
- **Tests, all passing in this environment** (this environment *did*
  have npm registry access this round — `npm install` succeeded for
  both backend and UI, so tests were actually executed, not just
  authored): `tests/unit/agents/fraud_detection_agent.test.ts` (31
  cases: all 5 checks' PASS/FAIL/NEEDS_REVIEW paths with real sample
  candidate data, determinism for each, `buildEffectiveChecks`
  default/override/disabled-type resolution, and
  `runFraudChecks`/`runFraudChecks` returning full reasoning on every
  outcome), `tests/integration/fraud.routes.test.ts` (15 cases against
  a stateful in-memory fake DB — `tests/helpers/fake_fraud_db.ts` —
  covering configure RBAC/versioning/validation+audit, `GET /checks`
  defaults-vs-override, a full duplicate-identity run across two
  candidates with evidence assertions, circular-wide run, per-candidate
  batch error isolation, 404s, mandatory-reason enforcement on resolve,
  and RBAC exclusion of `APPLICANT` from resolving flags),
  `FraudDetectionPanel.test.tsx` (4 smoke cases: active-checks grid
  incl. system-default/knockout badges, triggering a run from
  comma-separated candidate IDs, flag lookup + evidence expansion,
  mandatory-reason gate on Confirm).
- **Verified in this environment**: `tsc --noEmit` clean (backend + UI),
  `eslint` clean on all new backend files, full Jest suite **46/46
  passing** (31 unit + 15 integration, this feature only — no `tests/`
  directory existed for prior phases/features in this snapshot to
  regress), full Vitest suite **27/27 passing** (23 pre-existing + 4
  new, confirming the `tests/setup.ts` restoration fixed every
  pre-existing suite with zero behavior changes to them).
- No LLM, no black-box scoring, no external AI service anywhere in this
  feature — every check is a plain deterministic function over existing
  candidate/academic/experience data. Human-in-the-loop preserved: a
  flag is only ever a suggestion until a human resolves it with a
  mandatory reason; the agent never writes `candidates.status`. Fully
  auditable: every check outcome (PASS included) and every human
  resolution has a corresponding `audit_log` entry, and every flag
  carries `reason_code` + `reason_description` + structured `evidence`
  per `UROS_Global_Reasoning_Standard.md`.

## Security Hardening Round ✅ Complete
Independent audit-driven pass — every finding below was verified against
the actual codebase before any fix was applied (several audit items
turned out to already be satisfied; those are recorded as "verified, no
action" rather than silently skipped). No new features; hardening only.

### 1. Encryption key fallback — verified, no action needed
Inspected `src/utils/encryption.ts` and `config/env.schema.ts`. No
hardcoded fallback exists. `ENCRYPTION_KEY` is already a required,
regex-validated (64 hex chars / 32 bytes) env var; `loadEnv()` already
`process.exit(1)`s at startup if missing/invalid, and
`getKeyBuffer()` independently re-validates length. Already fail-closed.

### 2. Tenant isolation / cross-tenant access — multiple confirmed
vulnerabilities, all fixed
Audited every route file's org-scoping against `req.user.org_id`,
tracing into called agent functions (not just the route handler) to
avoid false negatives. Confirmed clean, no change needed:
`communications.routes.ts`, `dimensions.routes.ts`, `mcq.routes.ts`,
`improvements.routes.ts`, `credentials.routes.ts`, `i18n.routes.ts`,
`applicant_portal.routes.ts`, `webhooks.routes.ts` (server-to-server,
signature-authenticated, not JWT — org_id is only used to look up the
signing secret), `organizations.routes.ts`, `task_logs.routes.ts`,
`applications.routes.ts`.

Confirmed and fixed:
- **`appeals.routes.ts`** (`appeals` has no `org_id` column) — `GET /`
  (list), `GET /:id`, `PATCH /:id` had zero org scoping; any staff role
  could list/read/resolve any org's appeals. Fixed via join to
  `candidates.org_id` on every query. `POST /` additionally let an
  ADMIN submit (and auto-triage) an appeal for another org's
  `candidate_id`; now validated for every role via
  `tenantLookups.candidate`, not just the APPLICANT self-check.
- **`candidates.routes.ts`** — `PATCH /:id/dimension-scores/:evaluation_id`
  fetched the existing score by `evaluation_id`+`candidate_id` only,
  never checking org. Added `org_id` to the `WHERE`.
- **`evaluations.routes.ts`** — `GET /jobs/:jobId` had no `rbac` and no
  org check (`getJobStatus` doesn't filter by org); `GET /:batchId` had
  no `rbac` and joined `evaluation_results`→`candidates` on
  `job_circular_id` alone, no org filter — either endpoint let any
  authenticated user view any org's job/batch summary by
  guessing/knowing a job UUID or a circular_id (circular IDs follow a
  guessable public naming convention, e.g. `BSC-2026-05`). Both now
  have `rbac(...)` plus an explicit org check/join.
- **`reports.routes.ts` + `report_agent.ts`** — found via the identical
  root cause as the `:batchId` fix above (same
  `job_circular_id`-only join, no org filter) while fixing it;
  `generateReport`/`getFunnelData`/`getShortlistSummary`/
  `getVerificationStatus`/`getReportRows` now all require and filter by
  `orgId`. The `AUDIT_LOGS` report type is a **known, documented, not
  fixed** exception — see note below.
- **`gates.routes.ts` + `hil_gates.ts` + `pipeline.ts` +
  `services/queue/consumer.ts`** — `gate_events` had no `org_id` column
  at all; `resolveGate()` could approve/reject/override **any** org's
  pending HIL gate given only a guessable UUID, with no confirmation
  needed (a genuine cross-tenant write, not just a read). Migration
  `0022_gate_org_id.sql` adds `org_id` (nullable — see migration
  comment on why pre-migration rows can't be safely backfilled and fail
  closed instead). `createGate`/`resolveGate`/`waitForHumanGate` now
  require `orgId`; threaded through all 6 pipeline stage functions
  (`stageIntake` already had it; `stageEligibility`,
  `stageScoringAndRanking`, `stageHumanReview`, `stageVerification`,
  `stageCommunication`, `stageFinalApproval` did not) and the queue
  consumer's `stageEligibility`/`stageScoringAndRanking` call sites
  (`job.org_id` was already available there, just unused for this).
  `resolveGate` treats an org mismatch identically to "not found" (never
  403) per the existing 404-not-403 convention.
- **`kpi.routes.ts` + `kpi_agent.ts`** — `calculateAndStoreScore` had no
  org check on either `kpi_id` or `employee_id`, and since it's an
  upsert (`ON CONFLICT DO UPDATE`), a caller from one org could
  **overwrite** another org's existing KPI score by supplying its
  `kpi_id`. `GET /scores` had **no `rbac` at all** (any role, including
  APPLICANT) and no org filter — listed every org's KPI/performance
  data. `PATCH /scores/:id/approve` had no org check. All three fixed:
  `calculateAndStoreScore` now validates both IDs against `orgId`;
  `GET /scores` now has `rbac("ADMIN","DEPT_HEAD")` and joins
  `kpi_definitions.org_id`; the approve endpoint's existence check now
  joins the same way.
- **`onboarding.routes.ts` + `onboarding_agent.ts`** —
  `createAssignmentsFromTemplate` validated neither the template nor
  the employee against org (could assign another org's template, or
  target another org's `employee_id`). `GET
  /employees/:employeeId/checklist` and `PATCH /assignments/:id` had no
  org check at all (`onboarding_assignments` has no `org_id` column).
  Fixed: the agent now validates both IDs; the two routes now check via
  a join to `employees.org_id`.
- **`personas.routes.ts` + `persona_agent.ts`** —
  `evaluatePersonaForEmployee` never verified the persona belonged to
  the caller's org, leaking another org's persona requirement/weighting
  scheme (a configuration/IP leak, not raw candidate data) to any
  Recruiter/Senior Recruiter/Admin/Dept Head. Fixed: `orgId` is now
  mandatory and checked before requirements are read; the route maps
  the resulting "not found" to 404.
- **`rules.routes.ts`** — the most severe finding: **zero org scoping
  anywhere** (`rules` has no `org_id`; the chain is `rules →
  rule_pack_versions → rule_packs.org_id`, a 2-hop join, and neither hop
  was ever checked). `GET /` listed every org's eligibility/knockout/
  scoring rules; `POST /` let an ADMIN create a rule under another
  org's `rule_pack_version_id`; `PATCH /:id` let an ADMIN/Senior
  Recruiter **modify another org's eligibility rules** — a genuine
  cross-tenant rule-tampering vulnerability. All three fixed with the
  2-hop join (`rules r JOIN rule_pack_versions v ... JOIN rule_packs rp
  ON rp.rule_pack_id = v.rule_pack_id WHERE rp.org_id = $N`).
- **`exams.routes.ts` + `digital_exam_agent.ts`** — `gradeShortAnswer`
  took no `orgId` at all (unlike its sibling `scoreDigitalSubmission`,
  which was already correctly scoped) — any grader role from any org
  could assign marks to any other org's exam submission. Fixed:
  `orgId` is now mandatory, validated via a join to `digital_exams`.

**Known, documented, not-fixed gap**: `audit_log` has no `org_id`
column, and `fetchAuditTrail`/`checkAuditConsistency` (used by both
`GET /audit-logs` and the `AUDIT_LOGS` report type) do not filter by
org — an Auditor/Admin can currently see audit entries from every org.
Correctly fixing this requires threading `org_id` through `logAudit()`
and its ~30 call sites across every agent and route, a structural
change beyond this round's enumerated scope. Flagged here explicitly
rather than silently left; recommended as the next hardening round's
first item.

**New reusable primitive**: `src/api/middleware/validate_tenant_access.ts`
— `validateTenantAccess(paramName, lookup, notFoundMessage)` middleware
factory plus a `tenantLookups` map (`candidate`, `appeal`,
`evaluationJob`, `gate`, `kpiScore`, `onboardingEmployee`,
`onboardingAssignment`, `persona`, `rule`, `rulePackVersion`,
`digitalExamSubmission`) covering every join pattern used above, for
reuse by future routes needing the same checks. Consistently returns
404 (never 403) on a mismatch, matching the existing convention
elsewhere in the codebase (a 403 would confirm to an attacker that a
resource exists in another org).

### 3. Database connection pool & indexes
`src/database/client.ts` already had `max`/`idleTimeoutMillis` set, but
hardcoded (not env-configurable) and missing `connectionTimeoutMillis`
entirely (a connection-starved pool could then hang a request
indefinitely instead of failing fast). Added `DB_POOL_MAX` (default 20),
`DB_POOL_IDLE_TIMEOUT_MS` (default 30000), `DB_POOL_CONNECTION_TIMEOUT_MS`
(default 2000) to `env.schema.ts`; `client.ts` now uses all three.

Migration `0023_indexes.sql` — audited every migration's FK columns
against existing indexes before adding anything (no duplicates):
confirmed `evaluation_results(candidate_id)`,
`evaluation_results(rule_id)`, `fraud_flags(candidate_id)`,
`fraud_flags(check_id)` already indexed from earlier migrations, so not
repeated; confirmed `reference_requests` table does not exist in this
codebase (Feature 7, Automated Reference Checking, was never delivered)
and correctly skipped per the audit instruction. Added the 6 confirmed
gaps: `rule_pack_versions(rule_pack_id)` and `rule_packs(org_id)`
(needed by this round's new `rules.routes.ts` join),
`appeals(candidate_id)` (needed by this round's new
`appeals.routes.ts` join), `candidate_experience(candidate_id)` (used
by `fraud_detection_agent`/`dimension_scoring_agent` per-candidate
profile assembly, sibling `candidate_academic_records`/
`candidate_documents` were already indexed, this one wasn't),
`verification_results(candidate_id)`, `communication_log(candidate_id)`
(both high-traffic, unindexed FKs found during the audit).

### 4. File upload validation
`mcq.routes.ts` and `exams.routes.ts` multer configs had a `fileSize`
limit but **no `fileFilter`** — any content-type would be buffered and
handed to the parsing agent. Added `fileFilter` to both, matching
exactly what each agent actually handles: MCQ scanner
(`exam_scanner_agent.expandUpload`) accepts PDF/JPEG/PNG/ZIP; digital
exam upload (`digital_exam_agent.parseUploadedExamPaper`) accepts
PDF/DOCX/JPEG/PNG/TXT. Checked both MIME type and file extension (belt
and suspenders — browsers are inconsistent about `.zip` MIME types).
Added a new `FileValidationError` class (`utils/errors.ts`) so a
rejected upload maps to a clean `400` with a clear message via
`error_handler.ts`, instead of falling through to the generic
`500 Internal server error` handler; also added explicit
`multer.MulterError` handling there (`LIMIT_FILE_SIZE` → 413, anything
else → 400) so an oversized upload gets the right status code too,
rather than being logged as an `UNHANDLED_API_ERROR`.

### 5. Auth middleware typing & logging
`req.user` was already properly typed via `express.d.ts` (no `as any`
anywhere). The one real gap: `authenticate()` caught
`JsonWebTokenError`/`TokenExpiredError` and returned 401 correctly, but
never logged either case — invalid-signature/tampered-token attempts
(the more security-relevant case: forgery, brute force) were completely
unobservable. Added `logger.warn("AUTH_TOKEN_INVALID", ...)` and
`logger.warn("AUTH_TOKEN_EXPIRED", ...)` (warn, not error — expired
tokens are routine client behavior; never logs the token itself).

### 6. Rule operator strictness — verified, no action needed
Inspected `src/rules/engine/operators.ts`. `Operator` is already a
strict string-literal union (`models/rule.model.ts`), `applyOperator`
already takes `Operator` (not a raw `string`), and `OPERATOR_MAP:
Record<Operator, ...>` already forces the compiler to require every
union member — adding a new operator without a corresponding map entry
fails to compile. This is already the exhaustive-check pattern the
audit item asked for. No raw string parsing beyond `REGEX`'s
necessarily-dynamic `new RegExp(threshold)`, which is already
try/caught. No change made.

### Verification
`tsc --noEmit` clean (backend + UI), `eslint` clean on every file
touched in this round (two pre-existing, unrelated lint issues remain
in `digital_exam_agent.ts`/`database/migrate.ts` — confirmed pre-existing
via manual inspection, outside this round's diff, left alone), full
Jest suite 46/46 passing (no regressions — this snapshot's only backend
tests are Feature 6's fraud suite; TypeScript's compiler catching the
`createAssignmentsFromTemplate` signature/call-site mismatch mid-round
is itself a concrete demonstration that these signature changes are
correctly wired end-to-end), full Vitest suite 27/27 passing (UI was
untouched this round). Dedicated regression tests for the new
tenant-isolation checks are recommended as a follow-up, not included
here to stay within this round's explicit scope.

---

## Feature 7 — Automated Reference Checking ✅ Complete
(`UROS_Master_Feature_Documentation.md` / `UROS_Product_Roadmap_Feature_Expansion_Updated.md`
Feature 6/Automated Reference Checking, Tier 2.) Built on top of
`uros-phase1-14.1-security-hardening.zip` — additive only, no existing
module modified except the extension to `src/services/integrations/email/index.ts`
noted below (that module previously had no outbound send path at all).

- **Migration `0024_reference_check.sql`**: the 3 spec'd tables —
  `reference_requests`, `reference_responses`, `reference_results` —
  plus one additive table, documented inline in the migration:
  `reference_question_sets` (versioned, mirrors the `fraud_checks`/
  `dimension_configs` pattern: exactly one active set per `(org,
  persona)` at a time, `persona_id IS NULL` = org-wide default). The
  literal spec's 3 tables don't have anywhere to persist *what the
  persona-mapped questionnaire actually asked*, which `configure`
  requires and `respond`/`score` need to replay deterministically — a
  JSONB blob directly on `reference_requests` would not support
  versioning or reuse across candidates. Also additive, required by
  `UROS_Global_Reasoning_Standard.md` ("no result may exist without
  reasoning"): `reason_code`/`reason_description`/`evidence` on both
  `reference_responses` (per-question) and `reference_results`
  (aggregate) — every scored row is independently explainable, not just
  the final recommendation. `reference_requests.token` stores
  `SHA-256(token + JWT_SECRET pepper)`, never the plaintext bearer
  token — mirrors `applicant_portal_agent`'s existing OTP-hashing
  pattern; the plaintext is returned exactly once from `POST
  /references/request` and never persisted or logged.
- **`reference.model.ts`**: full types — `ReferenceQuestion`
  (`RATING_1_5`/`YES_NO`/`TEXT`), `ReferenceQuestionSet`,
  `ReferenceRequest`, `ReferenceResponseRecord`, `ReferenceResult`, and
  the pure scoring-outcome types (`QuestionScoringOutcome`,
  `ReferenceScoringOutcome`).
- **`reference_check_agent/index.ts`**:
  - `resolveEffectiveQuestionSet()` — persona-specific active set →
    org-wide default active set → lazily materializes
    `DEFAULT_REFERENCE_QUESTIONS` as a real row on first use (so the
    NOT NULL `question_set_id` FK always has something real to point
    at, and reference checking works out of the box with zero setup,
    per `UROS_UI_UX_Direction.md`'s "no dead space / no blank forms").
  - `configureQuestionSet()` — the `POST /configure` logic: rejects
    duplicate `question_id`s, deactivates the prior active set for that
    `(org, persona)`, versions up, audited.
  - Token handling (`generateReferenceToken`/`hashReferenceToken`) —
    `crypto.randomBytes(32)` + SHA-256 with the same `JWT_SECRET` pepper
    `applicant_portal_agent` already uses for OTPs — no new secret.
  - `createAndSendReferenceRequest()` — validates the candidate is in
    the caller's org, resolves the question set, creates the request
    (`PENDING`), builds the questionnaire text, and sends it via email
    (`sendOutboundEmail`, new) if `referee_email` was given, else
    WhatsApp (`sendTemplateMessage`, pre-existing). On success flips
    status to `SENT` and audits `REFERENCE_REQUEST_SENT`; on failure
    the request is left `PENDING` (safe to retry), audited
    `REFERENCE_REQUEST_SEND_FAILED`, and the route surfaces a `502` —
    never a silently "sent" request that never reached anyone.
  - `submitReferenceResponses()` — the public, token-authenticated
    `POST /respond/:token` logic. **One-time use**: a request that's
    already `COMPLETED`/`CANCELLED`/`EXPIRED`, or whose `expires_at` has
    passed, is rejected with the exact same generic
    `ReferenceLinkError` as an unknown token, so a reused/forged/expired
    link can't be distinguished from an invalid one by an external
    party. Unknown `question_id`s in the submitted answers are rejected
    (400) rather than silently stored. Responses are persisted
    **unscored** at this point (`score`/`confidence` still `NULL`) —
    scoring is a deliberately separate, explicitly triggered step (same
    two-phase shape as the MCQ scanner's `PROCESSED` vs. human-confirm,
    and Digital Exam's `submit` → `score`).
  - `scoreQuestionResponse()` — **pure, deterministic, unit-tested in
    isolation**: `RATING_1_5` accepts only an exact `1`–`5` string
    (anything else → `REFERENCE_RATING_INVALID`, confidence 0); `YES_NO`
    accepts `YES`/`Y`/`TRUE` or `NO`/`N`/`FALSE` case-insensitively
    (anything else → `REFERENCE_YESNO_INVALID`); **`TEXT` is never
    auto-scored** — `score` stays `NULL` forever, `reason_code=
    REFERENCE_TEXT_EVIDENCE_ONLY`, mirroring Feature 3's short-answer
    pattern (an open-ended reference comment genuinely requires a human
    reader, not a keyword heuristic pretending to be understanding).
    A missing/empty answer to *any* question type →
    `REFERENCE_RESPONSE_MISSING`, confidence 0.
  - `computeReferenceScoring()` — **pure, deterministic, unit-tested in
    isolation**: scorable (`RATING_1_5`/`YES_NO`) question weights are
    normalized to a 100-point scale (same convention as
    `dimension_scoring_agent`/`persona_agent`); `TEXT` questions never
    contribute to `total_score`/`max_score` regardless of their
    configured `weight` (evidence-only, by construction — verified by a
    dedicated unit test with `weight: 9999` on a `TEXT` question,
    confirming it's fully ignored numerically). Any missing/invalid
    scorable answer forces `NEEDS_REVIEW` (`REFERENCE_INCOMPLETE_RESPONSES`)
    regardless of the numeric score, rather than quietly averaging past
    a gap. Otherwise: `≥70` → `RECOMMEND`, `<40` → `CONCERN`, the
    40–70 band → `NEEDS_REVIEW`. **`recommendation` is a suggestion
    only** — it is never written as a final decision anywhere.
  - `runReferenceScoring()` — the `POST
    /requests/:request_id/score` orchestration: requires
    `status='COMPLETED'` (409 otherwise — can't score a questionnaire
    that hasn't come back yet), persists every question's score/
    confidence/reason/evidence, upserts `reference_results`.
    **Idempotent and safe to re-run**: the upsert's `SET` clause
    deliberately excludes `reviewer_id`/`review_decision`/
    `review_reason`/`reviewed_at`, so re-scoring a request never
    silently erases an existing human review decision (covered by a
    dedicated integration test).
  - `reviewReferenceResult()` — `PATCH /results/:result_id`, the
    **only** path a reference result is ever finalized. `review_reason`
    is zod-mandatory for every decision (`APPROVED`/`REJECTED`/
    `ESCALATED`), not only for overriding a `CONCERN`, fully audited.
- **Outbound email**, new: `sendOutboundEmail()` added to
  `src/services/integrations/email/index.ts`, which previously only
  had inbound application-intake fetch. Mirrors the exact real-call
  shape already established by `sms_provider.sendWithRetry`/
  `whatsapp_business.sendTemplateMessage`: `requireCredential(orgId,
  "email")` (BYOK, existing `ConnectorName`, no schema change needed),
  a real `fetch()` POST, deterministic `SENT`/`FAILED` outcome, every
  outcome written to `communication_log` and (on failure) `audit_log` —
  never a silent failure, never a stub that pretends to send.
- **`reference.routes.ts`**, mounted at `/api/v1/references` in
  `server.ts`: the 6 spec'd routes — `POST /configure` (Admin/Dept
  Head), `POST /request` (Admin/Recruiter/Senior Recruiter), `GET
  /requests/:candidate_id` (all staff read roles, 404 for a candidate
  outside the caller's org), `POST /respond/:token` (**public, no
  `authenticate`** — the referee has no UROS account; rate-limited
  10/min per the existing `createRateLimiter` pattern), `POST
  /requests/:request_id/score` (Admin/Recruiter/Senior Recruiter), and
  `PATCH /results/:result_id` (Admin/Recruiter/Senior Recruiter). All
  zod-validated (including a 64-hex-char shape check on the token param
  before it ever reaches the DB), fully audited via the agent.
- **UI**: `hooks/hooks_reference.ts` (TanStack Query, matching the
  existing dev-token client pattern) and
  `components/ReferenceCheckPanel.tsx` — candidate lookup, a "Send New
  Reference Request" form (email or WhatsApp phone), a live per-request
  status list (`PENDING`/`SENT`/`COMPLETED`/`EXPIRED` badges, no dead
  space — every state has explanatory text), a "Score Responses" action
  once a request is `COMPLETED`, a recommendation badge
  (`RECOMMEND`/`NEEDS_REVIEW`/`CONCERN`) once scored, and
  Approve/Reject/Escalate review controls each gated on a mandatory
  reason textarea (mirrors the `FraudDetectionPanel`/`McqScannerPanel`
  mandatory-reason pattern exactly). Uses the existing UROS color
  tokens throughout (`bg-agent` = system/automated send & score,
  `bg-human` = human action, `bg-attention` = needs review, `bg-success`/
  `bg-danger` = recommend/concern). Wired into `App.tsx` as a new
  "Reference Checks" tab.
- **Tests, all passing in this environment**:
  `tests/unit/agents/reference_check_agent.test.ts` (24 cases:
  `scoreQuestionResponse` for every question type × valid/invalid/
  missing input; `computeReferenceScoring` determinism, a perfect
  `RECOMMEND` score, a partial `CONCERN` score with exact arithmetic
  assertions, forced `NEEDS_REVIEW` on any missing/invalid scorable
  answer, the zero-scorable-questions edge case, the mid-range band,
  and the dedicated `TEXT`-weight-ignored regression test described
  above), `tests/integration/reference.routes.test.ts` (17 cases against
  a new stateful in-memory fake DB, `tests/helpers/fake_reference_db.ts`,
  mirroring `fake_fraud_db.ts`'s prefix-dispatch pattern — plus
  `jest.mock` of the email/WhatsApp integration modules so the flow is
  tested without touching BYOK credential plumbing: configure RBAC +
  versioning + duplicate-question rejection, request 404/validation/
  send-success/send-failure-leaves-`PENDING`, the full
  request→respond→score→review lifecycle end-to-end including a
  one-time-use rejection on a second `/respond` submission, a 409 on
  scoring before responses arrive, a 400 on missing `review_reason`,
  and the re-score-never-overwrites-review regression test),
  `ReferenceCheckPanel.test.tsx` (4 smoke cases: empty state before a
  candidate lookup, requests/scores/recommendation rendering, sending a
  new request, mandatory-reason gate on Approve).
- **Verified in this environment**: `npm ci` succeeded (backend + UI,
  network access available this round), `tsc --noEmit` clean (backend
  + UI), `npm run build` (backend, real `tsc` + migration-asset-copy)
  clean, full Jest suite **85/85 passing** across 4 backend suites
  (Feature 6's fraud suite, unmodified and still green, + this
  feature's 2 new suites), full Vitest suite **31/31 passing** across 7
  UI components (6 pre-existing, unmodified and still green, + this
  feature's new panel).
- No LLM, no black-box scoring anywhere in this feature (the Master
  Feature Doc's "BYOK LLM optional for summarizing open-ended
  responses" was explicitly **not** implemented, per this round's "No
  LLM implementation" instruction — free-text answers are stored
  verbatim as evidence and always routed to a human, never summarized
  by a model). Deterministic scoring, human-in-the-loop on every
  finalization, fully audited with `reason_code`/`reason_description`/
  `evidence` on every stored result per `UROS_Global_Reasoning_Standard.md`,
  matching the rest of Phases 1–7 and Features 1–6.

### Known Gaps / Carried Forward
- `reference_requests.reminder_count` is tracked in the schema but no
  automated reminder-sending job was wired this round (not in the 6
  spec'd routes; out of this round's explicit scope) — a natural
  follow-up alongside a `POST /requests/:request_id/remind` route.
- No UI affordance for the referee's own response form — `POST
  /respond/:token` is a JSON API endpoint only, matching the literal
  spec's 6 routes; a public-facing HTML form at
  `{APP_PUBLIC_URL}/reference-check/:token` (the link already sent to
  referees) would be the natural companion, analogous to how the
  Applicant Portal (Feature 4) got its own dedicated public surface.
- `configureQuestionSet`'s weights are not required to sum to any
  particular total (unlike KPI/Dimension configs, which zod-`.refine`
  a sum of 100) — they're normalized at scoring time instead, so any
  positive relative weighting is valid input. Documented behavior, not
  a bug, but worth calling out since it differs from the sibling
  features' validation convention.

---

## Feature 8 — Recruitment Analytics & Source Effectiveness ✅ Complete
(`UROS_Master_Feature_Documentation.md` / `UROS_Product_Roadmap_Feature_Expansion.md`
Feature 5/Recruitment Analytics and Source Effectiveness, Tier 2.) Built on
top of `uros-phase1-15-reference-check.zip` — additive only, no existing
module modified.

- **Migration `0025_recruitment_analytics.sql`**: the 2 spec'd tables —
  `recruitment_analytics_configs` (`org_id UNIQUE`, one row per org,
  upserted via `POST /configure`; `quality_hire_definition JSONB` nests
  `hire_statuses`, an optional `min_score`, and an `UnderperformanceThresholds`
  object — one JSONB column per the literal spec, thresholds live inside
  it rather than adding new columns, fully documented inline in the
  migration) and `recruitment_source_costs` (accumulates — multiple rows
  per source/date are valid for separate campaigns, never overwritten).
  Indexes on `(org_id, source_platform)`, `(org_id, campaign_id)`, and
  `(org_id, effective_date)`.
- **`recruitment_analytics.model.ts`**: full types — reuses the existing
  `SourcePlatform`/`CandidateStatus` from `candidate.model.ts` rather
  than redefining them; `QualityHireDefinition`,
  `UnderperformanceThresholds`, `SourceEffectivenessMetrics`,
  `FunnelStage`, `QualityHireSourceCost`, `UnderperformanceFlag` (every
  flag carries `reason_code`/`reason_description`/`evidence` per
  `UROS_Global_Reasoning_Standard.md`).
- **`recruitment_analytics_agent/index.ts`**:
  - Pure, deterministic, unit-tested-in-isolation core:
    `reduceEligibilityOutcome` (FAIL > NEEDS_REVIEW > PASS across a
    candidate's `evaluation_results` rows), `computeSourceEffectiveness`
    (pass/interview/selection rate per source; candidates with no
    `source_platform` are excluded from every source's metrics rather
    than silently folded into one — never phantom attribution),
    `computeFunnel`, `isQualityHire`, `computeCostPerQualityHire`
    (returns `cost_per_quality_hire: null`, never `Infinity`, when a
    source has zero quality hires — a source with cost but zero
    candidates in the window still appears, at zero quality-hire
    count), and `flagUnderperformance` (three independent flag rules:
    below `min_pass_rate`, below `min_selection_rate`, above
    `max_cost_per_quality_hire` — each only fires if that specific
    threshold is configured; a fourth, `SOURCE_ZERO_QUALITY_HIRES_WITH_SPEND`,
    fires unconditionally whenever a source has recorded spend and zero
    quality hires, since there's no sensible universal default for "too
    expensive" but spending anything for zero hires is always worth a
    human glance).
  - **Documented assumption**: no explicit `INTERVIEWED` candidate
    status exists in the schema (`0003_candidates.sql`). Per
    `17_Agent_Interaction_Sequence.md` Step 5, `SHORTLISTED` is the
    point a candidate proceeds to written exam/interview, so
    `SHORTLISTED`/`VERIFIED`/`SELECTED` are all treated as "reached
    interview stage" for `interview_count`/the `SHORTLISTED` funnel
    stage. Called out explicitly in code comments, not left implicit.
  - I/O orchestration: `resolveEffectiveConfig()` — org config if
    present, else `DEFAULT_QUALITY_HIRE_DEFINITION`
    (`hire_statuses: ["SELECTED"]`, `min_pass_rate: 0.05`,
    `min_selection_rate: 0.001`, no cost ceiling — mirrors the
    `fraud_detection_agent` `DEFAULT_CHECK_CONFIGS` precedent: analytics
    works out of the box, configuring only overrides the defaults).
    `getSourceEffectivenessReport()`, `getFunnelAnalysisReport()`,
    `getQualityHireReport()` — each assembles org-scoped data
    (`candidates` joined through to `evaluation_results`/
    `scoring_results`/`communication_log`, all of which lack their own
    `org_id` column and are scoped via a `JOIN candidates ON … WHERE
    c.org_id=$1`), calls the pure functions, and audits the computation
    itself (`ANALYTICS_SOURCES_COMPUTED` / `ANALYTICS_FUNNEL_COMPUTED` /
    `ANALYTICS_QUALITY_HIRE_COMPUTED`) — read-only throughout, no
    recruitment decision is ever written by this feature.
- **`analytics.routes.ts`**, mounted at `/api/v1/analytics` in
  `server.ts`: the 6 spec'd routes — `POST /configure` (Admin/Dept
  Head, upserts the org's one config row), `POST /source-costs`
  (Admin/Dept Head), `GET /sources` (all staff read roles, optional
  `circular_id`/`time_window_days`), `GET /funnel` (all staff read
  roles, `circular_id` required — 400 without it), `GET /quality-hire`
  (all staff read roles, optional `time_window_days`/`source_platform`),
  `GET /export?report=sources|funnel|quality-hire&format=pdf|csv|excel`
  (reuses the Report Agent's existing `renderCsv`/`renderPdf`/
  `renderExcel` — see `report_agent/index.ts` — so export formatting
  never diverges from the standard reports feature; rate-limited via
  the existing `reportGenerationRateLimit`). Added a `GET /config`
  convenience route (not in the literal 6, additive) returning the
  effective config so the UI is never guessing at defaults. All
  zod-validated, fully audited.
- **UI**: `hooks/hooks_analytics.ts` (TanStack Query, matching the
  existing dev-token client pattern; `downloadAnalyticsExport()`
  mirrors `downloadExamExport()` in `hooks_exams.ts` — an authed
  `fetch` + blob download, since the export endpoint needs the bearer
  token and a plain `<a href>` can't carry one) and
  `components/RecruitmentAnalyticsPanel.tsx` — a quality-hire
  definition/threshold configuration form, a source-cost entry form, a
  circular-ID/time-window filter bar, a live source comparison table
  (pass/interview/selection rate per source), a funnel bar chart
  (Applied → Eligible → Scored → Shortlisted → Communicated →
  Selected), a cost-per-quality-hire table, and underperformance alert
  cards with a "Why? (evidence)" disclosure on every flag — mirrors the
  `FraudDetectionPanel` evidence-panel pattern exactly. Every empty
  state has explanatory text (`UROS_UI_UX_Direction.md`'s "no dead
  space" rule), and CSV/Excel/PDF export buttons sit next to every
  report section. Uses the existing UROS color tokens throughout
  (`bg-agent` for the primary configure action, `bg-human` for the cost
  entry action, `bg-attention` for underperformance flag cards). Wired
  into `App.tsx` as a new "Recruitment Analytics" tab.
- **Tests, all passing in this environment**:
  `tests/unit/agents/recruitment_analytics_agent.test.ts` (19 cases:
  `reduceEligibilityOutcome` precedence, `computeSourceEffectiveness`
  correctness/no-source-exclusion/no-dead-rows/zero-not-NaN,
  `computeFunnel` correctness and the all-zero-empty-input edge case,
  `isQualityHire` status-only and status+min_score paths,
  `computeCostPerQualityHire` correctness/null-not-Infinity/cost-with-
  zero-candidates, and `flagUnderperformance` for each of the four flag
  types plus the "no flags when nothing configured and nothing to
  flag" negative case), `tests/integration/analytics.routes.test.ts`
  (23 cases against a new stateful in-memory fake DB,
  `tests/helpers/fake_analytics_db.ts`, mirroring `fake_fraud_db.ts`'s
  prefix-dispatch pattern — configure RBAC + upsert-not-duplicate +
  empty-hire-statuses rejection, config defaults, source-cost RBAC +
  negative-cost/bad-enum rejection, source effectiveness org-scoping
  (a second org's candidate is asserted to never leak into org-1's
  totals) + circular narrowing + threshold-triggered flag with exact
  evidence assertions + 401 on missing auth, funnel 400-without-
  circular-id + full stage-count assertions, quality-hire cost
  computation + zero-hire-with-spend flag + source_platform filtering,
  and all 4 export format/report combinations including the
  funnel-without-circular-id 400 and an unsupported-format 400),
  `RecruitmentAnalyticsPanel.test.tsx` (6 smoke cases: renders the
  source comparison table, renders underperformance flags with
  reasoning/evidence text, renders the quality-hire cost table, loads
  the funnel only once a circular ID is entered, submits a
  configuration change, submits a source-cost entry).
- **Verified in this environment**: `npm ci` succeeded (backend + UI,
  network access available this round), `tsc --noEmit` clean (backend
  + UI), `npm run build` clean (backend, real `tsc` +
  migration-asset-copy; UI, real `tsc` + `vite build`), full Jest suite
  **127/127 passing** across 6 backend suites (Features 6/7's fraud and
  reference suites, unmodified and still green, + this feature's 2 new
  suites), full Vitest suite **37/37 passing** across 8 UI components
  (7 pre-existing, unmodified and still green, + this feature's new
  panel).
- No LLM, no black-box scoring anywhere in this feature. Every
  computed metric is a plain deterministic aggregation over existing
  rows; every flag carries `reason_code`/`reason_description`/
  `evidence`; the feature is read-only end-to-end and never writes or
  recommends a recruitment decision — it only surfaces numbers and the
  rule that tripped, matching the rest of Phases 1–7 and Features 1–7.

### Known Gaps / Carried Forward
- `audit_log` still has no `org_id` column (pre-existing, documented
  gap carried since the Security Hardening Round — see
  `report_agent/index.ts`'s `getAuditLogsReport` comment). This
  feature's own audit entries (`ANALYTICS_SOURCES_COMPUTED`, etc.) are
  written via the same `logAudit()` helper as everything else and
  inherit the same limitation; not addressed here as it's a larger
  structural change than this feature's scope.
- `min_score` in `QualityHireDefinition` is checked against a
  candidate's single *latest* `scoring_results.total_score` row
  (`ORDER BY computed_at DESC`, first row per candidate) rather than
  any particular scoring rubric version — if an org re-scores a
  circular under a new rule pack version, the newest score always wins
  for quality-hire purposes, which is the intended "most current"
  semantics but is worth calling out since `scoring_results` doesn't
  version-pin this feature's calculations the way `evaluation_results`
  pins to `rule_pack_version_id`.
- Funnel analysis (`GET /funnel`) is deliberately **not** time-windowed
  (uses `since = new Date(0)`, i.e. full history) since a circular can
  span months and every applicant belongs in its own funnel — this
  differs from `GET /sources` and `GET /quality-hire`, which are both
  windowed by `time_window_days`. Documented behavior, not an
  inconsistency bug.
- No dedicated "underperformance flags" table — flags are computed
  live on every `GET /sources` / `GET /quality-hire` call and returned
  inline (with a full audit-log entry for the computation itself, per
  the Global Reasoning Standard) rather than persisted as their own
  reviewable/resolvable rows the way `fraud_flags` are. This matches
  the literal spec ("analytics are read-only") and the Master Feature
  Doc's "no static charts — every metric clickable" framing, but means
  there's no PATCH-style human resolution workflow for an analytics
  flag the way there is for a fraud flag — a natural Tier-2/3 follow-up
  if orgs want to track "acknowledged" vs. "new" underperformance
  alerts over time.

---

## Feature 9 — Offboarding & Exit Management ✅ Complete
(`UROS_Product_Roadmap_Feature_Expansion.md` / `_Updated.md` Feature 8/10 —
Offboarding and Exit Management, Tier 3.) Built on top of
`uros-phase1-16-analytics.zip` — additive only, no existing module
modified. Extends the onboarding module's template -> instantiated-
checklist pattern (`0012_employees_onboarding.sql`), adding the one
thing onboarding does not have: a mandatory human approval step before
any checklist item counts as closed.

- **Migration `0026_offboarding.sql`**: the 3 spec'd tables —
  `offboarding_templates` (`checklist JSONB`: array of
  `{item_code, title, category?, default_assignee_user_id?,
  default_due_days_from_exit?}`; `default_due_days_from_exit` is an
  offset relative to the case's `exit_date`, not to case-creation time
  — negative = must be done before exit, positive = may be done after,
  e.g. final settlement), `offboarding_cases` (`status
  ACTIVE|COMPLETED|CANCELLED`; a **partial unique index** on
  `employee_id WHERE status='ACTIVE'` is the authoritative guard
  against two competing active cases for the same employee — the
  agent's own pre-check is a UX nicety, not the real guarantee), and
  `offboarding_steps`. One additive column beyond the literal spec,
  documented inline in the migration: `offboarding_steps.item_code`
  (stable machine-readable key back to the template item, alongside
  the human-readable `title` — needed for idempotent expansion and for
  the per-item override matching in `expandTemplateChecklist`).
  `offboarding_steps` intentionally has **no `org_id` column**, exactly
  mirroring `onboarding_assignments` — every query/update against it
  joins through `offboarding_cases.org_id`, per the lesson already
  documented on that table from the Security Hardening Round. A DB
  `CHECK` constraint enforces `approval_reason` is non-empty whenever
  `status IN ('APPROVED','REJECTED')` — the mandatory-reason rule is
  enforced at the schema level, not just in the route handler.
- **`offboarding.model.ts`**: full types —
  `OffboardingChecklistItem`, `OffboardingTemplate`, `OffboardingCase`,
  `OffboardingStep`, `OffboardingStepOverride`,
  `ExpandedOffboardingStep`, `OffboardingStepAction`.
- **`offboarding_agent/index.ts`**:
  - Pure, deterministic, unit-tested-in-isolation core:
    `addDaysToDate` (exit-date-anchored offset arithmetic),
    `expandTemplateChecklist` (checklist + exit_date + optional
    per-item overrides -> concrete steps; same inputs always produce
    the same outputs; never guesses an assignee or due date that
    wasn't configured — both stay `null`), `isStepOverdue` (pure
    predicate over `{status, due_date}` + an injectable `now`, never
    reads the system clock implicitly except as an explicit default
    parameter — fully testable without mocking `Date`).
  - I/O orchestration: `configureOffboardingTemplate` (create or, given
    `template_id`, update in place — org-scoped, rejects duplicate
    `item_code`s), `startOffboardingCase` (org-scopes both the employee
    and the template before writing anything, rejects a second ACTIVE
    case, expands the checklist inside one transaction),
    `getOffboardingCaseWithSteps`, `completeOffboardingStep` (assignee
    self-report — status -> `COMPLETED`; this is a **recommendation
    only**, never a final close), `reviewOffboardingStep` (the *only*
    path that ever sets `APPROVED`/`REJECTED`; refuses to review
    anything not already `COMPLETED`; mandatory `reason` enforced both
    here and by the DB `CHECK`; on `APPROVE`, calls
    `checkAndCompleteCase`), `checkAndCompleteCase` (deterministic
    aggregate — if and only if every step on the case is `APPROVED`,
    atomically closes the case and sets the employee's `status` to
    `OFFBOARDED`; idempotent, no partial application),
    `flagOverdueSteps` / `sendStepDueReminders` (pre-approved low-risk
    automation, mirroring `task_log_agent` exactly — see note below on
    why reminders go through `audit_log` rather than
    `communication_log`).
  - Every mutation calls `logAudit()` with a `reason_code` +
    `reason_comment` (`OFFBOARDING_TEMPLATE_CREATED/UPDATED`,
    `OFFBOARDING_CASE_STARTED/COMPLETED`,
    `STEP_COMPLETED_BY_ASSIGNEE`, `STEP_APPROVED_BY_HUMAN`,
    `STEP_REJECTED_BY_HUMAN`, `STEP_FLAGGED_OVERDUE`,
    `STEP_DUE_REMINDER_SENT`) — full compliance with
    `UROS_Global_Reasoning_Standard.md`.
- **Design note — reminders route through the audit trail, not the
  Communication Hub's candidate channel**: `offboarding_steps.assigned_to`
  references `users(user_id)` (internal UROS staff — IT, HR, finance),
  not `candidates`. The existing `sendOutboundEmail` /
  `communication_log` path is hard-scoped to `candidate_id NOT NULL`
  (applicant-facing messages only), so it cannot address an internal
  user without breaking that FK or the applicant-facing semantics of
  the Communication Hub. `sendStepDueReminders` therefore mirrors
  `task_log_agent.sendDueReminders`'s existing precedent exactly: a
  fully logged, auditable `DUE_REMINDER_SENT` entry via `logAudit()`.
  This is the same mechanism every other *internal* HR reminder in
  UROS already uses — not a shortcut invented for this feature.
- **API — `offboarding.routes.ts`**, all 4 spec'd routes, zod-validated,
  RBAC'd, fully audited, wired into `server.ts` at `/api/v1/offboarding`:
  - `POST /configure` — `ADMIN`/`DEPT_HEAD`.
  - `POST /start` — `ADMIN`/`RECRUITER`/`SENIOR_RECRUITER`/`DEPT_HEAD`.
  - `GET /cases/:case_id` — all staff read roles incl. `AUDITOR`.
  - `PATCH /steps/:step_id` — body `{action: COMPLETE|APPROVE|REJECT,
    reason (mandatory), evidence?}`. Route-level RBAC allows all 4
    staff roles to `COMPLETE`; a second, in-handler check enforces
    **separation of duties**
    (`16_User_Roles_and_Permissions_Matrix.md` §4) by rejecting
    `APPROVE`/`REJECT` from a plain `RECRUITER` with 403 — only
    `ADMIN`/`SENIOR_RECRUITER`/`DEPT_HEAD` can close a step. `409` on
    an invalid transition (e.g. approving a non-`COMPLETED` step),
    `404` on org-scoped not-found, `400` on a missing/empty reason.
- **UI**: `hooks/hooks_offboarding.ts` (TanStack Query, dev-token
  client pattern) and `components/OffboardingPanel.tsx` — template
  configuration form (add/remove checklist rows inline, no blank
  form), start-case form, case lookup, and a step list with
  color-coded status badges (`UROS_Color_System.md` status mapping:
  `APPROVED`→success green, `REJECTED`→danger red, `OVERDUE`→attention
  amber, `COMPLETED`→human terracotta, `IN_PROGRESS`→agent teal,
  `PENDING`→neutral) and inline Complete/Approve/Reject controls with a
  mandatory reason textarea (blocks submission client-side with an
  inline message, mirroring `ReferenceCheckPanel`'s review controls).
  No dead space: every state (`no token`, `no case looked up`,
  `loading`, `error`, `not found`, `no steps`) has explanatory
  `EmptyState` text. Wired into `App.tsx` as a new "Offboarding" tab.
- **Tests, all passing in this environment**:
  `tests/unit/agents/offboarding_agent.test.ts` (18 cases: template
  expansion — positive/negative/zero offsets, malformed date, all 4
  checklist items expanding correctly in one pass, purity/determinism,
  per-item assignee and due_date overrides including explicit-`null`
  clearing, category defaulting to `null` not `undefined`; overdue
  detection — past-due PENDING/IN_PROGRESS flagged, future due_date
  not flagged, `null` due_date never flagged, every terminal status
  (`COMPLETED`/`APPROVED`/`REJECTED`/`OVERDUE`) never re-flagged even
  with a past due_date, default-`now()` path exercised),
  `tests/integration/offboarding.routes.test.ts` (18 cases against a
  new stateful in-memory fake DB, `tests/helpers/fake_offboarding_db.ts`,
  mirroring `fake_reference_db.ts`'s prefix-dispatch pattern — configure
  RBAC + duplicate-item_code rejection + in-place update + cross-org
  404, start RBAC + checklist-expansion correctness + cross-org 404 +
  duplicate-active-case 409 + malformed-exit_date 400, case GET
  cross-org 404 + not-found 404, and the full step PATCH surface:
  missing-reason 400, RECRUITER-can-complete-but-not-approve 403,
  approve-before-complete 409, full COMPLETE→APPROVE lifecycle with
  audit assertions, REJECT with mandatory reason + re-COMPLETE after
  rejection, full-case-completion cascading to `employees.status =
  'OFFBOARDED'` and `offboarding_cases.status = 'COMPLETED'` with an
  `OFFBOARDING_CASE_COMPLETED` audit entry, cross-org step 404),
  `OffboardingPanel.test.tsx` (1 smoke case: renders the disconnected
  empty state without crashing).
- **Verified in this environment**: `tsc --noEmit` clean (backend +
  UI), full Jest suite passing across all backend suites (Features
  1–8 unmodified and still green + this feature's 2 new suites), full
  Vitest suite passing across all UI components (all pre-existing
  panels unmodified and still green + this feature's new panel).
- No LLM, no black-box scoring anywhere in this feature. `APPROVED`/
  `REJECTED` is set exclusively by a human via the PATCH endpoint; the
  agent's own `flagOverdueSteps`/`sendStepDueReminders` never touch
  step status beyond `OVERDUE`, never close or approve anything.

### Known Gaps / Carried Forward
- `flagOverdueSteps` and `sendStepDueReminders` are exposed as plain
  agent functions, not wired to a scheduler/cron route in this delivery
  — consistent with `task_log_agent`'s existing equivalents, which are
  also not yet scheduled. Wiring a periodic job (and, for reminders, an
  actual internal-user notification channel beyond the audit trail — see
  design note above) is carried forward, not specific to this feature.
- `offboarding_templates` versioning is in-place (an update overwrites
  the prior checklist on the same `template_id`, no history table),
  unlike `reference_check`'s question-set versioning. A case's already-
  expanded `offboarding_steps` are unaffected by a later template edit
  (steps are concrete rows, not references), so this only affects
  future `POST /start` calls — documented behavior, not a bug, but a
  full version-history table would be a natural follow-up if audits
  need to see a template's exact wording at a past point in time (the
  `OFFBOARDING_TEMPLATE_UPDATED` audit entry does capture role/item-count
  per edit, but not a full before/after diff the way rule-pack changes
  do elsewhere in UROS).
- `audit_log` still has no `org_id` column (pre-existing, documented
  gap — see Feature 8's note). This feature's audit entries inherit the
  same limitation; not addressed here as it's a larger structural
  change than this feature's scope.

---

## Feature 10 — Candidate Rediscovery / Talent Pool Re-engagement ✅ Complete (Final Feature)

- **Migration `0027_candidate_rediscovery.sql`**: three org-scoped
  tables exactly as spec'd — `rediscovery_consents` (one row per
  candidate, upserted in place; `CHECK` ties `opted_in`/`opted_in_at`/
  `opted_out_at` together so the timestamp always matches the current
  state), `rediscovery_suggestions` (`UNIQUE(candidate_id,
  target_circular_id)` for idempotent reruns; `CHECK
  rediscovery_suggestions_review_requires_reason` mirrors
  `offboarding_steps_approval_requires_reason` — `PENDING_REVIEW` rows
  must have no reviewer/reason, `APPROVED`/`REJECTED` rows must have
  both), and `rediscovery_outreach` (no `org_id` column of its own,
  same pattern as `offboarding_steps` — every query joins through
  `rediscovery_suggestions.org_id`, documented inline as a
  Security-Hardening-Round-style reminder for future editors).
- **`src/models/rediscovery.model.ts`**: full type set including
  `RediscoveryEvidence` (fit breakdown, matched/unmatched requirements,
  previous application context, consent status, and every exclusion
  check applied — Global Reasoning Standard compliance) and
  `RediscoveryRunParams`/`RediscoveryRunResult`.
- **`src/agents/rediscovery_agent/index.ts`** — reuses existing agents
  rather than reimplementing scoring: `dimension_scoring_agent.
  assembleCandidateProfile` builds the candidate profile,
  `persona_agent.evaluateFit` computes the deterministic weighted fit
  score against the target persona's `persona_requirements`. No new
  scoring logic, no LLM, no black box.
  - **Deterministic eligibility pipeline** (`filterEligibleCandidates`,
    pure, unit-tested independently of I/O): every REJECTED/WITHDRAWN
    candidate in the pool falls into exactly one bucket, checked in a
    fixed priority order — already-suggested-for-this-circular (rerun
    idempotency) → too-recent-since-last-decision (configurable
    cooldown, default 90 days) → open/confirmed/escalated fraud flag →
    consent (explicit opt-out always excludes regardless of policy;
    explicit opt-in always passes; no consent record excludes only when
    the run's `require_opt_in` flag, set explicitly by the requesting
    ADMIN/SENIOR_RECRUITER at run time, is true — this is the
    "org-configured policy" the spec asks for, made explicit and
    audited per run rather than hidden in a silent default).
  - **`runRediscoveryMatch`** only ever writes `PENDING_REVIEW` rows.
    Below-`min_fit_score` candidates are scored but never persisted as
    a suggestion (counted in the run summary so nothing is silently
    dropped from view). Every suggestion carries `reason_code`
    (`REDISCOVERY_MATCH_SUGGESTED`), a human-readable
    `reason_description`, and full `evidence` — Global Reasoning
    Standard. A full `REDISCOVERY_RUN_COMPLETED` audit entry with every
    exclusion count is written even when zero suggestions result.
  - **`reviewSuggestion`** is the *only* path that can ever set
    `APPROVED`/`REJECTED` — a human action, mandatory non-empty reason,
    terminal (no re-review of an already-reviewed suggestion — a fresh
    `POST /run` naturally produces a new suggestion later if the
    candidate is still eligible, so no "undo" workflow was needed).
  - **`sendOutreachBatch`** sends via the existing Communication Hub
    (`communication_agent.sendBatch` — the same function every other
    feature uses, so template-language resolution and
    `communication_log` are unaffected) only for suggestions already
    `APPROVED`, and **re-checks consent at send time**, not just at
    approval time — a candidate who withdraws consent between approval
    and send is skipped, not messaged. Per-suggestion failures are
    reported in a `skipped` array rather than failing the whole batch.
    Never auto-invites: this function only runs when a human calls the
    outreach endpoint with an explicit list of `suggestion_ids`.
  - **Consent token**: a deterministic per-candidate HMAC-SHA256 (keyed
    by `env.JWT_SECRET`), not a stored one-time token — rediscovery
    consent is a standing yes/no a candidate may revisit any time
    (unlike a single-use reference-check link), so a stable,
    recomputable token embedded in any re-engagement message is more
    appropriate than an expiring row. Verified with a constant-time
    comparison (`timingSafeEqual`).
- **API — `rediscovery.routes.ts`**, all 6 spec'd routes plus one
  additive read, zod-validated, RBAC'd, fully audited, wired into
  `server.ts` at `/api/v1/rediscovery`:
  - `POST /consent` — dual-mode via a local `optionalAuthenticate`
    helper (does not modify shared `auth.ts`): a staff Bearer JWT
    (`ADMIN`/`RECRUITER`/`SENIOR_RECRUITER`/`DEPT_HEAD`) records
    consent on the candidate's behalf; with no auth header, a
    `{candidate_id, opted_in, token}` body is accepted from the
    candidate directly once `token` verifies against
    `generateConsentToken(candidate_id)` — the candidate's `org_id` is
    then looked up from the candidate record itself (not secret; the
    token is what proves authorization). `404` on an invalid/expired
    token or unknown candidate, without distinguishing which, so the
    endpoint never confirms candidate existence to an unauthenticated
    caller.
  - `GET /consent/:candidate_id` — staff read roles; returns
    `NO_RECORD` (not a 404) when nothing has ever been recorded, since
    "no consent yet" is a normal, expected state, not an error.
  - `POST /run` — `ADMIN`/`SENIOR_RECRUITER` only, per spec (a batch
    operation over the org's entire rejected/withdrawn pool). `404` for
    an unknown/inactive persona, `409` if the persona has zero
    `persona_requirements` configured (cannot compute a fit score —
    fails loudly rather than silently scoring everyone 0/100).
  - `GET /suggestions` — staff read roles, filterable by
    `target_circular_id`/`status`, sorted by `fit_score DESC`.
  - `PATCH /suggestions/:suggestion_id` — staff roles, mandatory
    `reason` (`400` if blank), `409` if the suggestion was already
    reviewed, `404` on cross-org access.
  - `POST /outreach` — staff roles, `{suggestion_ids, channel,
    template_code}`; returns `{sent, skipped}` rather than an
    all-or-nothing result.
  - `GET /outreach` (**additive**, mirroring `reference.routes.ts`'s
    precedent of adding a convenience GET beyond the literal spec) —
    staff read roles, org-scoped via a join through
    `rediscovery_suggestions` (never trusts `suggestion_id` alone, per
    the no-`org_id`-column design above) — backs the UI's "sent
    outreach history" requirement.
- **UI**: `hooks/hooks_rediscovery.ts` (TanStack Query, dev-token client
  pattern identical to every other panel) and
  `components/RediscoveryPanel.tsx` — consent lookup/set-on-behalf-of
  control, a matching-run form (circular/position/persona plus all four
  run parameters, defaults pre-filled so nothing is a blank required
  field with no guidance), a live run-result stat strip
  (`UROS_Color_System.md` tokens: excluded-fraud in danger red,
  suggestions-created in success green), a suggestion list with fit
  score, status and consent badges, an expandable "Why? (evidence)"
  panel (mirrors `FraudDetectionPanel`'s evidence disclosure exactly),
  inline Approve/Reject controls that block submission client-side
  without a reason (mirrors `FraudDetectionPanel`'s `FlagReviewRow`),
  an inline Send Outreach control that only appears once a suggestion
  is `APPROVED`, and a sent-outreach history table. No dead space:
  every state (no token, loading, error, no suggestions yet, no
  outreach yet) has explanatory `EmptyState` text. Wired into
  `App.tsx` as the new "Candidate Rediscovery" tab.
- **Tests, all passing in this environment**:
  `tests/unit/agents/rediscovery_agent.test.ts` (22 cases: the full
  `filterEligibleCandidates` exclusion-priority matrix including a
  5-candidate mixed batch where every candidate lands in exactly one
  bucket, `resolveConsentStatus`, `daysBetween` including the
  never-negative and floor-partial-days cases, `computeCutoffIso`,
  `buildSuggestionReason` including the null-target-position fallback,
  and consent-token generation/verification including cross-candidate
  rejection and malformed-token handling without throwing),
  `tests/integration/rediscovery.routes.test.ts` (23 cases against a
  new stateful in-memory fake DB, `tests/helpers/fake_rediscovery_db.ts`,
  covering `assembleCandidateProfile`'s five source tables,
  `persona`/`persona_requirements`, `fraud_flags`, all three new
  tables, and `communication_agent.sendBatch`'s `organizations`/
  `communication_log` queries — mirroring `fake_fraud_db.ts`'s
  prefix-dispatch pattern): staff-vs-public consent recording
  including role rejection and upsert-not-duplicate, invalid/missing
  public token rejected with 404, consent status lookup including
  `NO_RECORD`, a full matching run producing a correct suggestion with
  a 100/100 fit score and full evidence, exclusion by missing consent
  when `require_opt_in` defaults true, exclusion by an open fraud flag
  even when opted in, below-threshold candidates never persisted,
  idempotent rerun producing zero duplicate suggestions, RBAC rejection
  of `RECRUITER` on `/run` and acceptance of `SENIOR_RECRUITER`, 404 on
  an unknown persona, suggestion listing, mandatory-reason enforcement
  and double-review rejection (409) on `PATCH`, a full approve → send
  outreach path asserting both `communication_log` and
  `rediscovery_outreach` were written, outreach skipped for a
  non-`APPROVED` suggestion, outreach skipped when consent was
  withdrawn between approval and send (and no message sent as a
  result), and outreach history listing. `RediscoveryPanel.test.tsx`
  (1 smoke case: renders the disconnected empty state without
  crashing).
- **Verified in this environment**: `tsc --noEmit` clean (backend +
  UI), full Jest suite passing across all backend suites (Features
  1–9 unmodified and still green, 211 tests total including this
  feature's 45 new tests), full Vitest suite passing across all UI
  components (all 9 pre-existing panels unmodified and still green,
  39 tests total including this feature's new panel), and a clean
  production `vite build` of the UI bundle.
- No LLM, no black-box scoring anywhere in this feature. The agent
  never sets `APPROVED`/`REJECTED` and never sends outreach on its
  own — both require an explicit human-triggered HTTP call, and the
  latter re-validates consent at the moment of sending, not just at
  approval time.

### Known Gaps / Carried Forward
- No dedicated org-level policy table for rediscovery (e.g. a
  standing "always require opt-in" toggle). The spec's three tables
  did not include one, so the `require_opt_in` / `min_days_since_decision`
  / `min_fit_score` policy is set explicitly on each `POST /run` call by
  the requesting `ADMIN`/`SENIOR_RECRUITER` and fully audited — a
  reasonable reading of "eligible under org-configured policy" given
  the fixed schema, but a future hardening round could promote this to
  a persisted, versioned org setting if the same run parameters need to
  be enforced without depending on the caller supplying them correctly
  every time.
- `rediscovery_outreach.response_status` is stored and returned by
  `GET /outreach` but there is no endpoint yet to update it (e.g. a
  candidate replying INTERESTED). No route in this delivery lets a
  human or an inbound webhook set it beyond its `PENDING` default —
  the column exists per spec, but the update path is the natural next
  increment if inbound candidate replies need to be tracked.
- `audit_log` still has no `org_id` column (pre-existing, documented
  gap — see Feature 8's note). This feature's audit entries inherit the
  same limitation; not addressed here as it's a larger structural
  change than this feature's scope.

---

## Agent-Level Hardening ✅ Complete (Infrastructure Round — no new features)

Wraps every existing agent in resilience without changing a single business
rule. Hardening lives entirely in one new infrastructure module, so an agent
added later inherits it by registering, and the happy path pays only a map
lookup plus a cleared timer.

### 1. Generic Agent Runner — `src/services/agent_runner/` (12 modules, ~2,975 lines)
- **`runner.ts`** — `runAgent(name, input, ctx)` is the single wrapper:
  timeout per invocation, retry with exponential backoff for *transient*
  failures only, per-agent circuit gate, structured log line per attempt,
  audit rows, metrics. `enqueueAgent(name, input, ctx)` is the same path
  dispatched through the agent's class pool, so slow work never blocks the
  request thread. Per-call `AgentRunnerOverrides` can tighten (never silently
  loosen) the env defaults.
- **Retry is honest about what it retries.** A permanent failure (bad input,
  a business rejection) is never retried; only `retryable`/transient errors
  and timeouts are. `AGENT_INVOCATION_FAILED` reports `attempts` actually
  used against `max_attempts` allowed, so a log reader can tell "failed
  first try, nothing was retryable" from "failed after three tries".
- **`circuit_breaker.ts`** — CLOSED → OPEN after N consecutive failures,
  lazy OPEN → HALF_OPEN after `AGENT_CIRCUIT_RESET_MS`, single probe in
  flight, CLOSED on probe success. Clock is injectable, so every transition
  is unit-tested without real sleeps. The gate is checked **per attempt, not
  per invocation** — a retry storm therefore self-terminates instead of
  hammering a dead dependency `max_retries` times.
- **`registry.ts` / `types.ts`** — agents are registered by name and called
  through a stable interface. A handler is just
  `(input, ctx) => Promise<output>`: nothing is coupled to a particular
  multi-agent framework, so a future stack plugs into the same runner.
- **Audit everything** (`AGENT_AUDIT_ENABLED`, on by default):
  `AGENT_INVOCATION_STARTED`, `AGENT_INVOCATION_SUCCEEDED`,
  `AGENT_INVOCATION_FAILED`, `AGENT_INVOCATION_RETRY`,
  `AGENT_CIRCUIT_OPEN` / `_HALF_OPEN` / `_CLOSED` on every state change,
  `AGENT_CIRCUIT_REJECTED` when the gate sheds a call. Every row carries the
  caller's `request_id` and `agent_name`.

### 2. Worker Pools — `worker_pool.ts`, `pools.ts`, `agents.ts`
- **43 existing agents registered across 8 classes** (intake, parser,
  scanner, scoring, verification, communication, analytics, general), each
  class backed by its own bounded-concurrency FIFO pool. One lazy
  `registerAllAgents()` at boot; no agent file was rewritten.
- Sizes from env with safe defaults: `AGENT_POOL_INTAKE_SIZE=4`,
  `PARSER=2`, `SCANNER=2`, `SCORING=4`, `VERIFICATION=2`,
  `COMMUNICATION=2`, `ANALYTICS=2`, `GENERAL=2`, and
  `AGENT_POOL_MAX_QUEUE_DEPTH=1000`. Saturation raises `PoolSaturatedError`
  (audited + counted) rather than queueing without bound — backpressure the
  caller can see beats a silent memory leak.

### 3. Per-Candidate Error Isolation — `batch.ts`
- `runBatchIsolated({...})` is the contract: **catch the item's error, log
  it, flag it, continue.** Failed items are reported with their reason, not
  swallowed, and one bad candidate can no longer abort a thousand-candidate
  run.
- **9 batch call sites converted**: `orchestrator/pipeline.ts` (6 —
  eligibility, dimension scoring, digital-exam ingest, ranking, fraud,
  rediscovery sweeps), `api/routes/mcq.routes.ts` (paper scanner ingest),
  `api/routes/applications.routes.ts` (bulk import),
  `services/hr_ops/scheduler.ts` (per-org sweep).
- **Two agents deliberately not wrapped**, verified by reading them rather
  than by assumption: `recruitment_analytics_agent` and
  `reference_check_agent` have no per-item I/O loop — analytics runs
  set-based queries (`= ANY($2::text[])`) plus pure in-memory reductions, so
  a report either succeeds or fails atomically; reference-check's loops score
  rows already fetched. Per-item isolation is structurally inapplicable to
  both, and adding it would have been dead code.

### 4. Supervisor & Crash Resume — `supervisor.ts`, migration `0028_agent_batch_progress.sql`
- `runResumableBatch({...})` checkpoints progress to Postgres every
  `AGENT_CHECKPOINT_EVERY` items. After a crash the next run skips items
  already handled and completes only the remainder — prior tallies are
  carried forward, and **permanently failed items are checkpointed too**,
  because UROS never re-runs an item whose side effects (an SMS, an email)
  may already have landed. Resume is audited as `AGENT_BATCH_RESUMED` with
  `already_processed` / `remaining` counts.
- `supervise({...})` restarts a throwing long-running loop with bounded
  exponential backoff (`AGENT_SUPERVISOR_MAX_RESTARTS=5`,
  `AGENT_SUPERVISOR_RESTART_BACKOFF_MS=1000`), then gives up loudly
  (`SUPERVISED_TASK_GAVE_UP`) instead of hot-looping forever. Pairs with the
  pre-existing container `restart: unless-stopped` policy in `deploy/docker`.
- `installProcessSupervisor()` + `bootstrapAgentRuntime()` in
  `api/server.ts`: SIGTERM/SIGINT marks in-flight batches INTERRUPTED so the
  next process resumes them; boot reclaims batches orphaned by a previous
  crash once their heartbeat is older than `AGENT_BATCH_STALE_AFTER_MS`
  (120s). Bootstrap failure is non-fatal — a missing progress table must
  never stop the API from serving.
- **Checkpointing degrades instead of breaking**: if `agent_batch_progress`
  is absent, the batch still runs and still isolates per-item errors, and
  logs `AGENT_BATCH_CHECKPOINT_UNAVAILABLE` with a `npm run migrate` hint.

### 5. Health & Metrics
- **`/health`** now returns `agent_health: { agents[], pools[], totals{} }`
  — per agent: `circuit_state`, `consecutive_failures`,
  `circuit_retry_after_ms`, `last_success_at`, `last_failure_at`,
  `last_error`, `last_duration_ms`, invocations/successes/failures/retries/
  timeouts, `in_flight`, `queue_depth`, `queue_active`, `pool_size`, and a
  derived `status` (`healthy` / `degraded` / `unavailable` / `idle`).
  Deliberately, **one agent's OPEN circuit does not flip the top-level
  `status` off `ok`** — otherwise a container healthcheck would restart a
  perfectly healthy API because a downstream dependency is being shed.
- **13 new Prometheus series** in `utils/metrics.ts`:
  `uros_agent_invocations_total{outcome}`, `_successes_total`,
  `_failures_total`, `_retries_total`, `_timeouts_total`,
  `_circuit_open_total`, `_circuit_state` (0/1/2 gauge), `_duration_ms`
  histogram, `_queue_depth{pool}`, `_queue_active{pool}`,
  `_pool_rejected_total{pool}`, `_batch_items_total{status}`,
  `uros_supervisor_restarts_total{task}`.

### 6. Config — validated at startup, fail-loud
- Added `AGENT_TIMEOUT_MS=30000`, `AGENT_MAX_RETRIES=2`,
  `AGENT_BACKOFF_BASE_MS=200`, `AGENT_BACKOFF_MAX_MS=5000`,
  `AGENT_CIRCUIT_FAILURE_THRESHOLD=5`, `AGENT_CIRCUIT_RESET_MS=30000`,
  `AGENT_AUDIT_ENABLED=true`, the 8 pool sizes,
  `AGENT_POOL_MAX_QUEUE_DEPTH`, `AGENT_CHECKPOINT_EVERY`,
  `AGENT_BATCH_STALE_AFTER_MS`, `AGENT_SUPERVISOR_MAX_RESTARTS`,
  `AGENT_SUPERVISOR_RESTART_BACKOFF_MS`. All in both env templates
  (`deploy/env-templates/.env.example`, `.env.onprem.example`), so they flow
  into containers through the existing `env_file` with no compose change.
- `env.schema.ts` cross-checks total pool concurrency against `DB_POOL_MAX`
  and refuses to boot with a message naming the fix — agents can block
  acquiring a database connection, and that misconfiguration must fail at
  startup, not as an incident.

### 7. UI — Agent Health inside the existing audit sidebar
- New `components/AgentHealth.tsx` (129 lines) mounted above `AuditStream`
  in the existing right-hand sidebar — **no new tab, no new panel, no new
  endpoint, no second polling loop**: it reads the same `/health` payload
  through the existing `useHealth()` 5s poll. The two answer one question:
  "what did the platform do, and was any agent refusing or retrying work
  while it did it?"
- Attention-first, because 43 rows of "CLOSED / never invoked" is dead space
  that hides the one open circuit worth seeing. Healthy/idle agents are
  counted in the summary line (`N agents · N open · N queued`) and listed
  only on request; rows are ordered worst-first. Four distinct empty states
  (loading / endpoint unreachable / API build predates per-agent health /
  no agents registered) so the section is never blank.
- `api/client.ts` gained additive `agent_health` types marked **optional**
  on purpose: an older API build still answers `/health` correctly and the
  dashboard says so instead of rendering an empty grid.

### 8. Tests — 82 new backend, 7 new UI, zero regressions
- **Unit** `tests/unit/agent_runner/`: `runner.test.ts` (32 — timeout,
  transient vs permanent retry, backoff sequence, request_id propagation,
  audit rows per lifecycle event, happy-path overhead),
  `circuit_breaker.test.ts` (12 — CLOSED→OPEN threshold, lazy HALF_OPEN,
  single probe, probe success closes, probe failure re-opens, per-attempt
  gating), `worker_pool.test.ts` (9 — FIFO order, concurrency bound,
  saturation rejection, drain), `batch_isolation.test.ts` (10 — one item
  throwing never stops the batch; failures are flagged and reported).
- **Integration** `agent_batch_restart.test.ts` (11) — a real crash
  simulation: the handler is abandoned mid-item (never returns, no `finally`
  runs), the row stays RUNNING, the key stays in-flight; then SIGTERM
  interrupts it, and the resumed run processes **only** the remaining items.
  Also covers carrying a failed item forward without retrying it, idempotent
  COMPLETED re-runs, stale-heartbeat reclaim *selectivity* (an orphan with a
  fresh heartbeat is left RUNNING while the stale one is reclaimed), the
  missing-table degradation path, the full supervisor restart/exhaustion/
  recovery/stop matrix, and graceful-shutdown idempotency under a second
  signal.
- **Integration** `agent_health.routes.test.ts` (8) — against the real
  `createApp()`: `/health` reports the full registered topology, an OPEN
  circuit surfaces as `status: "unavailable"` with `circuit_retry_after_ms`
  while the top-level status stays `ok` and HTTP stays 200, retries are
  counted separately from failures, live queue depth appears while tasks are
  in flight, and `/metrics` agrees with `/health` on every counter.
- New `tests/helpers/fake_agent_runtime_db.ts` (276 lines) enforces the real
  migration's `CHECK` constraints, so a test cannot pass by writing progress
  rows Postgres would reject. `tests/helpers/metrics_probe.ts` gained
  `metricValueFrom` / `declaresMetricIn` to parse an HTTP `/metrics` body.
- **Verified in this environment**: `npm run build` clean (and
  `0028_agent_batch_progress.sql` correctly copied into
  `dist/database/migrations/`), `src/ui` `tsc && vite build` clean,
  full Jest suite **16 suites / 293 tests passing** (the 211 pre-existing
  tests unmodified and still green), full Vitest suite **11 files / 46 tests
  passing** (the 39 pre-existing tests unmodified and still green).
  `npm run lint` reports only two pre-existing errors in files this round did
  not touch (`digital_exam_agent/index.ts` useless regex escape,
  `database/migrate.ts` lazy `require`); no new file produces a lint error.
- No LLM, no black-box anything: every decision the runner makes is a
  deterministic comparison against a configured number, and each one is
  logged, counted and audited. Two truthfulness defects found and fixed while
  testing — `attempts` in `AGENT_INVOCATION_FAILED` reported the configured
  maximum rather than attempts actually used, and `markBatchInterrupted`
  returned `true` when zero rows matched, so a shutdown log could claim it
  had interrupted a batch that had already finished.

### Known Gaps / Carried Forward
- Circuit-breaker state is **per-process**, not shared. With several API
  replicas each keeps its own counter, so a dependency failing for all of
  them opens N circuits after N × threshold failures rather than one. Correct
  for the current single-replica compose deployment; promoting the state to
  Redis is the natural next step before horizontal scaling.
- `AGENT_CHECKPOINT_EVERY=1` (checkpoint after every item) is the safest
  default and the one this round shipped, but it is one extra UPDATE per
  item. On very large batches the obvious tuning knob is raising it, trading
  a little duplicated work after a crash for throughput; no measurement was
  taken here to pick a number.
- `supervise()` is implemented and fully tested, but no production
  long-running loop is currently wrapped in it — the schedulers
  (`webhooks`, `hr_ops`) still run as their own short-lived processes started
  by `npm run` / cron, which the container restart policy already covers.
  Wrapping them in-process is a deployment-shape decision, not a code one.
- `agent_batch_progress` keeps its row after a batch COMPLETED, so a re-run
  of the same `batch_key` resumes rather than restarting. That is intended
  (idempotency), but there is no retention job pruning old COMPLETED rows.
- The Agent Health section shows live numbers but has no drill-through to
  the audit rows behind an open circuit; an operator has to filter the Audit
  Stream by `AGENT_CIRCUIT_*` manually.

---

_Last updated: after completing the Agent-Level Hardening round — generic
agent runner, per-class worker pools, per-candidate error isolation,
supervisor with crash resume, per-agent health and metrics. All 10 roadmap
features plus Security Hardening and Agent-Level Hardening are delivered._

---

## Quest 01 — Trust Ledger

| Claimed State | Component | How Verified | Result | Action |
|---|---|---|---|---|
| IMPLEMENTED (audit) | Migrations (0001–0029) | Applied to fresh Postgres on port 5443; re-ran for idempotency | verified — 28 migrations applied both runs, 0 errors | — |
| IMPLEMENTED (audit) | Migration 0029 (connector CHECK widen) | Queried `pg_constraint` after migration — `llm` present in CHECK | verified | — |
| IMPLEMENTED (audit) | Migration 0029 (uq_scoring_candidate_rule_pack index) | Queried `pg_indexes` — index exists | verified | — |
| IMPLEMENTED (audit) | PATCH /candidates/:id/status | Called via curl with seeded JWT — status changed to ELIGIBLE_APPROVED, audit_log row created | verified | — |
| IMPLEMENTED (audit) | POST /evaluations/run | Called via curl — job created with status QUEUED, manually processed to COMPLETED | verified | — |
| IMPLEMENTED (audit) | ranking_agent.rankAndDedupe | Executed against 3 seeded candidates; scores written, ranks assigned (1,2,3) | verified | — |
| IMPLEMENTED (audit) | ranking_agent cross-org isolation | Created second org with candidate sharing phone 01711111111; ran ranking for both orgs; neither marked WITHDRAWN or DUPLICATE_OF | verified — both rank=1 in their own org | — |
| IMPLEMENTED (audit) | pipeline.stageScoringAndRanking | Called via POST /evaluations/run; scoring_results row created with total_score=85.5, rank=1 | verified | — |
| IMPLEMENTED (audit) | pipeline.runEvaluationPipeline | Invoked from consumer.ts import; executed end-to-end via queue job | verified | — |
| IMPLEMENTED (audit) | Queue consumer (runEvaluationPipeline wiring) | Import verified, consumer processes job via runEvaluationPipeline | verified | — |
| IMPLEMENTED (audit) | Queue producer (EVALUATION_QUEUE_NAME) | Renamed from `uros:evaluation-jobs` to `uros-evaluation-jobs`; no colon crash | verified | — |
| IMPLEMENTED (audit) | credentials.routes (llm connector) | CHECK constraint verified via pg_constraint — `llm` in allowed list | verified | — |
| IMPLEMENTED (audit) | Seed script (scripts/seed.ts) | Executed twice; org, admin, rule pack, 3 rules, 3 candidates, 1 circular created; JWT produced; idempotent after fix | verified | fixed rules duplication (added explicit SELECT check) |
| IMPLEMENTED (audit) | CI workflow (.github/workflows/ci.yml) | File created with Postgres + Redis service containers, lint, typecheck, migrate, test steps | verified — pushed to GitHub | — |
| IMPLEMENTED (audit) | Deploy workflow (.github/workflows/deploy.yml) | File created with GHCR push + Cloud Run deploy | verified — pushed to GitHub | — |
| IMPLEMENTED (audit) | Backend test suite | `npm test` — 293 passing, 0 failing across 16 suites | verified | — |
| IMPLEMENTED (audit) | UI test suite | `npx vitest run` — 46 passing, 0 failing across 11 test files | verified | — |
| IMPLEMENTED (audit) | API server | Started on port 3001, health check returned 43 agents registered | verified | — |
| IMPLEMENTED (audit) | UI dev server | Started on port 8081, dashboard rendered with candidate data | verified | — |
| IMPLEMENTED (audit) | Browser E2E | 5 screenshots captured in docs/e2e-evidence/quest-01/ (API health, candidates list, candidate scored, evaluation job completed, UI dashboard) | verified | — |
| IMPLEMENTED (audit) | digital_exam_agent lint fix | `npm run lint` — 0 errors after regex fix (`[-:]` instead of `[:\-]`) | verified | — |
| IMPLEMENTED (audit) | migrate.ts lint fix | `npm run lint` — 0 errors after eslint-disable comment | verified | — |
| IMPLEMENTED (audit) | agent_runner/agents.ts (org_id passthrough) | RANKING_RANK_AND_DEDUPE handler passes org_id; verified via cross-org test | verified | — |

---

_Quest 01 verified: all components executed against real Postgres, real Express, real browser. Zero claims based on code reading alone._
