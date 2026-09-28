# Rebuild Log

Chronological record of schema changes, breaking changes, and migration events.

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
