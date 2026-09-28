-- 0005_audit_log.sql
CREATE TABLE audit_log (
    audit_id        BIGSERIAL PRIMARY KEY,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    agent_or_user    TEXT NOT NULL,
    action          TEXT NOT NULL,
    rule_id         UUID REFERENCES rules(rule_id),
    input_value     JSONB,
    output_value    JSONB,
    reason_code     TEXT,
    reason_comment  TEXT,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_time ON audit_log(timestamp);

-- Immutability: no update/delete role grants at all (append-only by design)
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
