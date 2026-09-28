-- Agent-Level Hardening: durable progress state for long-running agent batches.
--
-- Purpose (infrastructure only — no business decision is stored here):
-- a batch that processes thousands of candidates can be killed mid-run by
-- a deploy, an OOM, or a node failure. Without persisted progress the only
-- safe options are "restart from zero" (duplicating side effects such as
-- SMS sends) or "give up". This table records *which items already
-- finished*, so a resumed run skips them and completes only the remainder.
--
-- One row per (batch_key). batch_key is chosen by the caller and must be
-- stable across restarts — e.g. "ELIGIBILITY:<circular_id>:<rule_pack_version_id>".
--
-- processed_keys is a JSONB array of the item keys already handled (success
-- OR permanently failed): both are "done" for resume purposes, because a
-- per-item failure is recorded, flagged and reported, not retried silently
-- (UROS never re-runs an item whose side effects may already have landed).
-- failures keeps the per-item reason so an operator can see exactly what
-- went wrong without re-running the batch.

CREATE TABLE agent_batch_progress (
    batch_key        TEXT PRIMARY KEY,
    agent_name       TEXT NOT NULL,
    org_id           UUID NULL,
    -- RUNNING      a process believes it owns this batch right now
    -- INTERRUPTED  the owning process died (stale heartbeat / SIGTERM); resumable
    -- COMPLETED    every item reached a terminal outcome
    -- FAILED       the batch itself could not run (bad input, missing config)
    status           TEXT NOT NULL DEFAULT 'RUNNING'
                     CHECK (status IN ('RUNNING','INTERRUPTED','COMPLETED','FAILED')),
    total_items      INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
    processed_count  INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
    succeeded_count  INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
    failed_count     INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    -- Items skipped on resume because a previous (crashed) run already did them.
    resumed_count    INTEGER NOT NULL DEFAULT 0 CHECK (resumed_count >= 0),
    -- How many times this batch_key has been (re)started. 1 = first run.
    attempts         INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    processed_keys   JSONB NOT NULL DEFAULT '[]'::jsonb,
    failures         JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_error       TEXT NULL,
    actor            TEXT NULL,
    request_id       TEXT NULL,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Bumped as progress is checkpointed. A RUNNING row whose heartbeat is
    -- older than AGENT_BATCH_STALE_AFTER_MS belongs to a dead process and is
    -- reclaimed as INTERRUPTED by the supervisor on boot.
    heartbeat_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A completed batch must have accounted for every item, and a batch that
    -- recorded work must have a heartbeat at or after its start. Both are
    -- cheap invariants that stop a bug in the checkpoint writer from leaving
    -- silently-inconsistent recovery state behind.
    CONSTRAINT agent_batch_progress_counts_consistent
        CHECK (succeeded_count + failed_count <= processed_count AND processed_count <= total_items),
    CONSTRAINT agent_batch_progress_completed_is_full
        CHECK (status <> 'COMPLETED' OR processed_count = total_items),
    CONSTRAINT agent_batch_progress_heartbeat_after_start
        CHECK (heartbeat_at >= started_at)
);

-- Supervisor recovery scan: "which RUNNING rows have gone quiet?".
CREATE INDEX idx_agent_batch_progress_recovery
    ON agent_batch_progress (status, heartbeat_at);

-- Operator view: recent batches for one agent (used by /health and the dashboard).
CREATE INDEX idx_agent_batch_progress_agent
    ON agent_batch_progress (agent_name, started_at DESC);
