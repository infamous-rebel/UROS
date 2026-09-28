-- 0007_evaluation_jobs.sql
-- Postgres-backed queue fallback (used when REDIS_URL is not configured)
-- and the durable record of every evaluation run regardless of backend.
CREATE TABLE evaluation_jobs (
    job_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id              TEXT NOT NULL,
    circular_id           TEXT NOT NULL,
    rule_pack_version_id  UUID NOT NULL REFERENCES rule_pack_versions(version_id),
    org_id                UUID NOT NULL REFERENCES organizations(org_id),
    stage                 TEXT NOT NULL CHECK (stage IN ('ELIGIBILITY','SCORING','BOTH')),
    status                TEXT NOT NULL DEFAULT 'QUEUED'
                           CHECK (status IN ('QUEUED','PROCESSING','COMPLETED','FAILED')),
    requested_by          UUID REFERENCES users(user_id),
    error                 TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at            TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ
);

-- Idempotency guard: only one active (QUEUED or PROCESSING) job may exist
-- for a given (circular, rule pack version, stage) at a time. A second
-- submission for the same triple hits this constraint and the producer
-- returns the existing job instead of enqueueing a duplicate.
CREATE UNIQUE INDEX uq_active_evaluation_job
    ON evaluation_jobs(circular_id, rule_pack_version_id, stage)
    WHERE status IN ('QUEUED','PROCESSING');

CREATE INDEX idx_eval_jobs_status ON evaluation_jobs(status);
