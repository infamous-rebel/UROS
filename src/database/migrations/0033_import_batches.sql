-- 0033_import_batches.sql
-- Quest 04 completion: durable batch metadata for pull-based intake.
--
-- Why: POST /api/v1/applications/import synthesises a batch_id but only
-- persists per-candidate rows; intake_agent.fetchBatch had nothing to
-- load batch metadata (source, circular, org) from and returned a stub.
-- This table records the batch marker at import/pull time so any later
-- process (agent runner, operator UI, recovery) can reconstruct exactly
-- what a batch was. Tenant-scoped by org_id per Rule 8.

CREATE TABLE IF NOT EXISTS import_batches (
    batch_id       TEXT PRIMARY KEY,
    org_id         UUID NOT NULL REFERENCES organizations(org_id),
    circular_id    TEXT NOT NULL,
    source         TEXT NOT NULL
                   CHECK (source IN ('Teletalk','bdjobs','LinkedIn','Email','WhatsApp','CSV')),
    status         TEXT NOT NULL DEFAULT 'ACCEPTED'
                   CHECK (status IN ('ACCEPTED','PROCESSING','COMPLETED','FAILED')),
    total_items    INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
    imported       INTEGER NOT NULL DEFAULT 0 CHECK (imported >= 0),
    failed         INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
    requested_by   TEXT NOT NULL,
    request_id     TEXT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_batches_org_created
    ON import_batches (org_id, created_at DESC);
