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

## Quest 03 — Batch Checkpoint Redesign

### New Table: `agent_batch_progress_item`

Per-item checkpoint records replacing the O(n²) JSONB array writes on `agent_batch_progress`.

| Column | Type | Notes |
|---|---|---|
| `batch_key` | TEXT NOT NULL | FK to `agent_batch_progress(batch_key)` ON DELETE CASCADE |
| `item_key` | TEXT NOT NULL | Candidate ID or other item identifier |
| `status` | TEXT NOT NULL | CHECK: `PROCESSED` or `FAILED` |
| `error` | TEXT | Failure reason (NULL for PROCESSED) |
| `processed_at` | TIMESTAMPTZ NOT NULL | Defaults to `now()` |

PK: `(batch_key, item_key)`

Indexes: `idx_abpi_batch_status` on `(batch_key, status)`

### New Columns on `agent_batch_progress`

| Column | Type | Notes |
|---|---|---|
| `owner_id` | UUID | Worker that currently owns the lease |
| `lease_expires_at` | TIMESTAMPTZ | When the current lease expires |
| `fencing_token` | BIGINT NOT NULL DEFAULT 0 | Monotonic counter preventing split-brain writes |
| `resumed_count` | INTEGER DEFAULT 0 | Number of times this batch has been resumed |
| `attempts` | INTEGER DEFAULT 0 | Number of execution attempts |

Indexes: `idx_agent_batch_progress_lease` on `(lease_expires_at)` WHERE `status = 'RUNNING'`

### Dropped Columns on `agent_batch_progress`

- `processed_keys` (JSONB) — replaced by `agent_batch_progress_item` rows with `status='PROCESSED'`
- `failures` (JSONB) — replaced by `agent_batch_progress_item` rows with `status='FAILED'`

### New Columns on `evaluation_jobs`

| Column | Type | Notes |
|---|---|---|
| `gate_id` | UUID | FK to `gate_events(gate_id)` — links CONTINUE_FROM_GATE jobs to their gate |
| `requested_by_name` | TEXT | Human-readable caller name for system-triggered jobs |

Stage CHECK widened: `'ELIGIBILITY','SCORING','BOTH','CONTINUE_FROM_GATE'`

Unique index updated: `uq_active_evaluation_job` now includes `COALESCE(gate_id, ...)` so multiple gates on the same circular aren't deduplicated.

### New Column on `gate_events`

| Column | Type | Notes |
|---|---|---|
| `resolved_by_name` | TEXT | Human-readable name of the resolver (from `users.full_name`) |

Index: `idx_gate_events_org_status_created` on `(org_id, status, created_at DESC)`

## Migration History

See `src/database/migrations/` for the full sequence. Key milestones:

- 0001: Initial schema (organizations, users, candidates)
- 0002: Added org_id to candidates
- 0022: Added org_id to gate_events
- 0030: Tenant isolation — added org_id to audit_log, evaluation_results, scoring_results, verification_results, communication_log, appeals
- 0031: Batch checkpoint redesign — per-item progress table, lease/fencing columns, CONTINUE_FROM_GATE stage, resolved_by_name audit trail
