# Rebuild Log

Chronological record of schema changes, breaking changes, and migration events.

## Quest 03 — Pipeline Wiring + Checkpoint Redesign

**Date**: 2026-09-29
**Migration**: `0031_batch_checkpoint_redesign.sql`

### Reason for Change

The original batch checkpoint stored progress as JSONB arrays (`processed_keys`, `failures`) on a single `agent_batch_progress` row. Every item completion required reading the entire JSONB array, appending, and writing it back — O(n²) write amplification for n items. A 10,000-candidate batch would perform ~100M bytes of JSONB writes. Additionally, there was no lease mechanism or fencing token — a crashed worker could silently resume, causing duplicate processing or split-brain writes.

The pipeline stages used `waitForHumanGate()` which blocked the calling worker for the entire duration of human review (potentially days). This tied up queue workers and made the pipeline fragile — a single stalled gate would hold a worker indefinitely.

### Schema Changes

1. **New table `agent_batch_progress_item`**: Per-item checkpoint rows (batch_key, item_key, status, error). O(1) write per item. PK: (batch_key, item_key). FK to parent with ON DELETE CASCADE.
2. **Lease/fencing columns on `agent_batch_progress`**: `owner_id UUID`, `lease_expires_at TIMESTAMPTZ`, `fencing_token BIGINT NOT NULL DEFAULT 0`. Lease-based concurrency: a worker must heartbeat to keep its lease; expired leases can be claimed by a new owner with an incremented fencing token.
3. **Backfill**: `processed_keys` JSONB → `agent_batch_progress_item` rows (status='PROCESSED'); `failures` JSONB → rows (status='FAILED'). Guarded by IF EXISTS on column.
4. **Drop JSONB columns**: `processed_keys` and `failures` dropped after backfill.
5. **Widen `evaluation_jobs`**: Stage CHECK adds `CONTINUE_FROM_GATE`; new `gate_id UUID FK` and `requested_by_name TEXT` columns; unique index updated to include gate_id.
6. **`gate_events.resolved_by_name TEXT`**: Human-readable audit trail for who resolved each gate.
7. **New indexes**: `idx_agent_batch_progress_lease` (partial on RUNNING), `idx_gate_events_org_status_created`.

### Code Changes

- **batch.ts**: Complete rewrite of checkpoint code. Per-item INSERTs replace JSONB array appends. Lease claim with fencing token. Heartbeat loop. `beginBatch` returns `pastFailures` for carry-forward. `alreadyProcessedKeys` rebuilt from `agent_batch_progress_item`.
- **pipeline.ts**: All 6 `waitForHumanGate` calls replaced with `createGate` (non-blocking). New `continueFromGate` dispatcher maps gate_type + decision to next pipeline stage. Rejection semantics: SHORTLIST_CONFIRMATION REJECT → candidates REJECTED; COMMUNICATION/FINAL REJECT → stay VERIFIED, audit only.
- **hil_gates.ts**: `createGate` accepts optional payload. `resolveGate` stores `resolved_by_name` (looked up from users.full_name) and enqueues CONTINUE_FROM_GATE job. New `listPendingGates(orgId)` for gate inbox.
- **gates.routes.ts**: New `GET /` endpoint for gate discovery (pending gates for caller's org).
- **queue/types.ts**: `CONTINUE_FROM_GATE` added to EvaluationStage; `requested_by` made optional; `gate_id` and `requested_by_name` fields added.

### Breaking Changes

- `agent_batch_progress.processed_keys` and `agent_batch_progress.failures` columns dropped. Any code reading these columns will fail.
- `evaluation_jobs.stage` CHECK widened — old clients sending only ELIGIBILITY/SCORING/BOTH still work, but CONTINUE_FROM_GATE is now valid.
- `evaluation_jobs.requested_by` is now nullable (was NOT NULL). System-triggered CONTINUE_FROM_GATE jobs have no human requester.

## Quest 02 — Tenant Isolation

**Date**: 2026-09-28
**Migration**: `0030_tenant_isolation.sql`

### Schema Changes

Added `org_id UUID` column to six tables that previously lacked tenant scoping:

1. `audit_log` — backfilled from candidates/evaluation_jobs/candidate_dimension_scores via entity_id; stays nullable for infrastructure-level entries (BATCH, PIPELINE_STAGE). Partial indexes only.
2. `evaluation_results` — backfilled via join to candidates; set NOT NULL.
3. `scoring_results` — backfilled via join to candidates; set NOT NULL.
4. `verification_results` — backfilled via join to candidates; set NOT NULL.
5. `communication_log` — backfilled via join to candidates; set NOT NULL.
6. `appeals` — backfilled via join to candidates; set NOT NULL.

All six tables received:
- Foreign key `REFERENCES organizations(org_id)`
- Composite indexes on `(org_id, ...)` for tenant-scoped queries

### Code Changes

- `audit_helper.logAudit` signature: `org_id` added as required field on `AuditLogEntry`. All 30+ call sites updated.
- `audit_agent`: `fetchAuditTrail`, `fetchEntityHistory`, `checkAuditConsistency` all require `orgId` as mandatory first parameter.
- `eligibility_agent.runEligibilityForCircular`: added `AND org_id=$2` to candidate query.
- All route handlers for the six tables now write and filter by `org_id`.
- Defense-in-depth: `candidates.routes.ts`, `applicant_portal_agent` now include direct `org_id` on evaluation_results/scoring_results queries even though transitively scoped.
- `appeals.routes.ts` PATCH handler: UPDATE WHERE clause now includes `AND org_id=$5`.

### Test Changes

- New: `tests/integration/tenant_isolation.test.ts` — 14 assertions covering cross-org isolation.
- New: `tests/unit/tenant_isolation_guard.test.ts` — regression guard scanning src/ for INSERT without org_id.
- Updated: `tests/unit/agent_runner/batch_isolation.test.ts` — audit param indices shifted +1 for org_id.
- Updated: `tests/integration/agent_batch_restart.test.ts` — same audit param shift.
- Updated: `tests/integration/agent_health.routes.test.ts` — same audit param shift.
- Updated: `tests/helpers/fake_rediscovery_db.ts` — communication_log INSERT handler includes org_id.

### Breaking Changes

- `AuditLogEntry.org_id` is now a required field for tenant-scoped entries. Infrastructure callers may pass `undefined` (becomes NULL).
- `audit_helper.logAudit` INSERT column order changed: `org_id` is now the first column ($1).

## Quest 01 — Foundation

**Date**: 2026-09-27
**Migrations**: 0001–0029

Initial schema, agents, pipeline, queue, evaluation engine, communication hub, fraud detection, reference checks, offboarding, rediscovery, applicant portal, digital exam, analytics, and CI/CD pipeline. See `progress.md` for the full Trust Ledger.
