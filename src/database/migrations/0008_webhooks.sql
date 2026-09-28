-- 0008_webhooks.sql

-- Inbound: every webhook received from an external platform is logged
-- here regardless of whether signature verification passed, for audit.
CREATE TABLE inbound_webhook_events (
    event_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            UUID REFERENCES organizations(org_id),
    connector         TEXT NOT NULL,
    signature_valid   BOOLEAN NOT NULL,
    headers           JSONB,
    payload           JSONB,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed         BOOLEAN NOT NULL DEFAULT false,
    processing_error  TEXT
);
CREATE INDEX idx_inbound_webhook_connector ON inbound_webhook_events(connector, received_at);

-- Outbound: webhook notifications UROS sends to external systems
-- (batch imported, evaluation completed, override made, verification
-- completed, appeal resolved — file 20 §5.6). Retried with exponential
-- backoff until max_attempts is reached.
CREATE TABLE webhook_deliveries (
    delivery_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(org_id),
    event_type      TEXT NOT NULL,
    target_url      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','DELIVERED','FAILED','RETRYING')),
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at    TIMESTAMPTZ
);
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries(status, next_retry_at);
