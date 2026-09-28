-- 0031_batch_checkpoint_redesign.sql
-- Quest 03: Eliminate O(n²) JSONB write amplification in agent_batch_progress,
-- add lease-based concurrency protection with fencing tokens, and widen
-- evaluation_jobs for the CONTINUE_FROM_GATE job type.
--
-- Changes:
--   1. New agent_batch_progress_item table (per-item progress, replaces JSONB arrays)
--   2. Lease/fencing columns on agent_batch_progress (owner_id, lease_expires_at, fencing_token)
--   3. Backfill processed_keys → agent_batch_progress_item (status='PROCESSED')
--   4. Backfill failures → agent_batch_progress_item (status='FAILED')
--   5. Drop processed_keys and failures JSONB columns
--   6. New indexes (lease, gate events)
--   7. Widen evaluation_jobs for CONTINUE_FROM_GATE (stage CHECK, gate_id, requested_by_name)
--   8. Add resolved_by_name to gate_events for audit trail
--
-- Idempotent: IF NOT EXISTS / IF EXISTS / NOT EXISTS guards throughout.

-- =====================================================================
-- 1. CREATE agent_batch_progress_item
-- =====================================================================

CREATE TABLE IF NOT EXISTS agent_batch_progress_item (
  batch_key    TEXT NOT NULL,
  item_key     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('PROCESSED','FAILED')),
  error        TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_key, item_key)
);

-- FK to parent table (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_abpi_batch_key') THEN
    ALTER TABLE agent_batch_progress_item
      ADD CONSTRAINT fk_abpi_batch_key
      FOREIGN KEY (batch_key) REFERENCES agent_batch_progress(batch_key) ON DELETE CASCADE;
  END IF;
END $$;

-- Index for batch-scoped status queries
CREATE INDEX IF NOT EXISTS idx_abpi_batch_status
  ON agent_batch_progress_item (batch_key, status);

-- =====================================================================
-- 2. ADD LEASE / FENCING COLUMNS to agent_batch_progress
-- =====================================================================

ALTER TABLE agent_batch_progress ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE agent_batch_progress ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE agent_batch_progress ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0;

-- =====================================================================
-- 3. BACKFILL processed_keys JSONB → agent_batch_progress_item (PROCESSED)
--    Guarded: only runs if processed_keys column still exists (idempotent).
-- =====================================================================

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_batch_progress' AND column_name = 'processed_keys'
  ) THEN
    EXECUTE '
      INSERT INTO agent_batch_progress_item (batch_key, item_key, status, processed_at)
      SELECT p.batch_key, elem, ''PROCESSED'', p.updated_at
      FROM agent_batch_progress p,
           LATERAL jsonb_array_elements_text(p.processed_keys) AS elem
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_batch_progress_item i
        WHERE i.batch_key = p.batch_key AND i.item_key = elem
      )
    ';
  END IF;
END $$;

-- =====================================================================
-- 4. BACKFILL failures JSONB → agent_batch_progress_item (FAILED)
--    Guarded: only runs if failures column still exists (idempotent).
-- =====================================================================

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'agent_batch_progress' AND column_name = 'failures'
  ) THEN
    EXECUTE '
      INSERT INTO agent_batch_progress_item (batch_key, item_key, status, error, processed_at)
      SELECT p.batch_key,
             (elem->>''key''),
             ''FAILED'',
             (elem->>''error''),
             p.updated_at
      FROM agent_batch_progress p,
           LATERAL jsonb_array_elements(p.failures) AS elem
      WHERE jsonb_typeof(p.failures) = ''array''
        AND NOT EXISTS (
          SELECT 1 FROM agent_batch_progress_item i
          WHERE i.batch_key = p.batch_key AND i.item_key = (elem->>''key'')
        )
    ';
  END IF;
END $$;

-- =====================================================================
-- 5. DROP JSONB COLUMNS (idempotent via IF EXISTS)
-- =====================================================================

ALTER TABLE agent_batch_progress DROP COLUMN IF EXISTS processed_keys;
ALTER TABLE agent_batch_progress DROP COLUMN IF EXISTS failures;

-- =====================================================================
-- 6. INDEXES
-- =====================================================================

-- Lease expiry scan for recovery (replaces heartbeat-based recovery index)
CREATE INDEX IF NOT EXISTS idx_agent_batch_progress_lease
  ON agent_batch_progress (lease_expires_at) WHERE status = 'RUNNING';

-- Gate events: org-scoped list with recency (keeps existing 0022 index untouched)
CREATE INDEX IF NOT EXISTS idx_gate_events_org_status_created
  ON gate_events (org_id, status, created_at DESC);

-- =====================================================================
-- 7. WIDEN evaluation_jobs for CONTINUE_FROM_GATE
-- =====================================================================

-- Stage CHECK: add CONTINUE_FROM_GATE
ALTER TABLE evaluation_jobs DROP CONSTRAINT IF EXISTS evaluation_jobs_stage_check;
ALTER TABLE evaluation_jobs ADD CONSTRAINT evaluation_jobs_stage_check
  CHECK (stage IN ('ELIGIBILITY','SCORING','BOTH','CONTINUE_FROM_GATE'));

-- gate_id: links CONTINUE_FROM_GATE jobs to their resolved gate
ALTER TABLE evaluation_jobs ADD COLUMN IF NOT EXISTS gate_id UUID REFERENCES gate_events(gate_id);

-- Update unique index to include gate_id (so multiple gates on same circular aren't deduplicated)
DROP INDEX IF EXISTS uq_active_evaluation_job;
CREATE UNIQUE INDEX uq_active_evaluation_job
  ON evaluation_jobs(circular_id, rule_pack_version_id, stage, COALESCE(gate_id, '00000000-0000-0000-0000-000000000000'))
  WHERE status IN ('QUEUED','PROCESSING');

-- requested_by: allow NULL for system-triggered jobs (was UUID FK to users)
ALTER TABLE evaluation_jobs ALTER COLUMN requested_by DROP NOT NULL;

-- requested_by_name: human-readable caller name for system jobs
ALTER TABLE evaluation_jobs ADD COLUMN IF NOT EXISTS requested_by_name TEXT;

-- =====================================================================
-- 8. GATE EVENTS: add resolved_by_name for audit trail
-- =====================================================================

ALTER TABLE gate_events ADD COLUMN IF NOT EXISTS resolved_by_name TEXT;
