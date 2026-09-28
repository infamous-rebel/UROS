# Security

## Tenant Isolation

Tenant isolation is the highest-severity security property of UROS. A cross-tenant leak — one missing `AND org_id = $n` — is a data breach.

### Enforcement Layers

1. **Schema**: Every tenant-scoped table carries `org_id UUID NOT NULL` (except `audit_log`, which is nullable for infrastructure-level entries). Foreign keys reference `organizations(org_id)`.

2. **Application code**: Every SQL query that reads or writes tenant-scoped data includes an `org_id` clause. This is enforced by:
   - Direct `org_id` filters on all six Quest 02 tables
   - Defense-in-depth: even when a query is transitively scoped (e.g., filtering by `candidate_id` where the candidate is already verified to belong to the org), a direct `org_id` filter is also applied
   - Route handlers extract `org_id` from the authenticated JWT (`req.user.org_id`) and pass it to every data access function

3. **Anti-enumeration**: Cross-tenant resource access returns 404 (not 403). An attacker cannot determine whether a resource exists in another tenant.

### How It Is Tested

- **Integration test** (`tests/integration/tenant_isolation.test.ts`): Two orgs (A and B) with complete fixture sets. Asserts:
  - Admin A sees only org A's audit entries, appeals, evaluations
  - Admin A gets 404 for org B's appeal/evaluation/candidate by ID
  - Audit log entity_id filter is still org-scoped
  - All six tables have non-null org_id in fixtures
  - Admin B sees only org B's data (symmetric check)

- **Regression guard** (`tests/unit/tenant_isolation_guard.test.ts`): Scans every `.ts` file under `src/` for `INSERT INTO` statements targeting the six tenant-scoped tables. Asserts every INSERT includes `org_id` in its column list. Catches future regressions at CI time.

### Tables Covered

| Table | org_id Column | Migration |
|---|---|---|
| `audit_log` | nullable (partial indexes) | 0030 |
| `evaluation_results` | NOT NULL | 0030 |
| `scoring_results` | NOT NULL | 0030 |
| `verification_results` | NOT NULL | 0030 |
| `communication_log` | NOT NULL | 0030 |
| `appeals` | NOT NULL | 0030 |

### Audit Helper

`logAudit()` in `src/utils/audit_helper.ts` requires `org_id` as a field on the `AuditLogEntry` interface. Infrastructure-level callers (batch runner, pipeline) that lack org context pass `undefined`, which becomes NULL in the database — the only permitted null path.

### Cross-Org Leak Sweep (Quest 02)

Every query in `src/` touching the six tables was audited. Known-risky files checked:
- `audit_agent/index.ts` — orgId mandatory on all functions
- `report_agent/index.ts` — joins include `c.org_id`
- `recruitment_analytics_agent/index.ts` — all queries scoped by `c.org_id`
- `dimension_scoring_agent/index.ts` — logAudit includes org_id
- `ranking_agent/index.ts` — logAudit includes org_id
- `fraud_detection_agent/index.ts` — logAudit includes org_id
- All route handlers — pass `req.user.org_id` to every query

## Authentication

JWT-based. Tokens carry `user_id`, `org_id`, and `role`. The `authenticate` middleware validates the token and attaches the decoded payload to `req.user`. The `rbac` middleware checks role authorization.

## Rate Limiting

Per-IP and per-candidate rate limits on sensitive endpoints (candidate lookup, OTP requests).

## Encryption

Sensitive fields (national ID, documents) are encrypted at rest using AES-256-GCM with a key derived from `ENCRYPTION_KEY` environment variable.
