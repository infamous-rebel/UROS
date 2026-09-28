-- 0009_outgoing_webhook_deliveries.sql
-- Canonical outbound webhook delivery queue for the scheduler
-- (src/services/webhooks/scheduler.ts). Supersedes the simpler
-- `webhook_deliveries` table from migration 0008 for new deliveries;
-- that table is left in place (harmless, unused going forward) rather
-- than dropped, since UROS never discards audit-relevant history.
CREATE TABLE outgoing_webhook_deliveries (
    delivery_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(org_id),
    event_type      TEXT NOT NULL,
    target_url      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','SUCCESS','FAILED','DEAD')),
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 6, -- length of the fixed backoff schedule
    next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at    TIMESTAMPTZ
);
CREATE INDEX idx_outgoing_webhook_due ON outgoing_webhook_deliveries(status, next_retry_at);
