# Data Model

## Entity Relationship Overview

UROS uses a multi-tenant PostgreSQL database. Every tenant-scoped table carries `org_id` with a foreign key to `organizations(org_id)`. Cross-tenant queries are structurally impossible — every `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on tenant data includes an `org_id` clause.

## Tenant-Scoped Tables

| Table | org_id | Added | Notes |
|---|---|---|---|
| `candidates` | NOT NULL | Migration 0002 | Core entity; all other tables scope through this or directly |
| `gate_events` | NOT NULL | Migration 0022 | Pipeline gate transitions |
| `audit_log` | nullable | Migration 0030 | Nullable: infrastructure-level entries (BATCH, PIPELINE_STAGE) may lack org context. Partial index on `(org_id, timestamp)` where org_id IS NOT NULL |
| `evaluation_results` | NOT NULL | Migration 0030 | Rule engine outcomes per candidate |
| `scoring_results` | NOT NULL | Migration 0030 | Dimension scoring totals per candidate |
| `verification_results` | NOT NULL | Migration 0030 | Source verification outcomes (NID, academic, etc.) |
| `communication_log` | NOT NULL | Migration 0030 | SMS/Email/WhatsApp delivery records |
| `appeals` | NOT NULL | Migration 0030 | Candidate appeal submissions and resolutions |

## Key Relationships

```
organizations (org_id PK)
  ├── candidates (org_id FK)
  │     ├── evaluation_results (org_id FK, candidate_id FK)
  │     ├── scoring_results (org_id FK, candidate_id FK)
  │     ├── verification_results (org_id FK, candidate_id FK)
  │     ├── communication_log (org_id FK, candidate_id FK)
  │     ├── appeals (org_id FK, candidate_id FK)
  │     └── gate_events (org_id FK, candidate_id FK)
  ├── audit_log (org_id FK, nullable — infrastructure entries may be null)
  ├── users (org_id FK)
  ├── job_circulars (org_id FK)
  └── ...
```

## Indexes (Quest 02)

All tenant-scoped tables carry composite indexes starting with `org_id`:

- `audit_log`: `(org_id, timestamp DESC)` partial WHERE org_id IS NOT NULL; `(org_id, entity_type, entity_id)` partial
- `evaluation_results`: `(org_id, candidate_id)`, `(org_id, status)`
- `scoring_results`: `(org_id, candidate_id)`
- `verification_results`: `(org_id, candidate_id)`, `(org_id, source, status)`
- `communication_log`: `(org_id, candidate_id)`, `(org_id, sent_at DESC)`
- `appeals`: `(org_id, status)`, `(org_id, candidate_id)`

## Migration History

See `src/database/migrations/` for the full sequence. Key milestones:

- 0001: Initial schema (organizations, users, candidates)
- 0002: Added org_id to candidates
- 0022: Added org_id to gate_events
- 0030: Tenant isolation — added org_id to audit_log, evaluation_results, scoring_results, verification_results, communication_log, appeals
