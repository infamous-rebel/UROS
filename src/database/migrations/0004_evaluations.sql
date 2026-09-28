-- 0004_evaluations.sql
CREATE TABLE evaluation_results (
    evaluation_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id           TEXT NOT NULL REFERENCES candidates(candidate_id),
    rule_id                UUID NOT NULL REFERENCES rules(rule_id),
    rule_pack_version_id   UUID NOT NULL REFERENCES rule_pack_versions(version_id),
    input_value            JSONB,
    status                 TEXT NOT NULL CHECK (status IN ('PASS','FAIL','NEEDS_REVIEW')),
    reason_code            TEXT NOT NULL,
    confidence              NUMERIC,
    distance_to_threshold   NUMERIC,
    evaluated_by            TEXT NOT NULL DEFAULT 'SYSTEM',
    evaluated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    human_reviewer           UUID REFERENCES users(user_id),
    human_decision           TEXT CHECK (human_decision IN ('APPROVE','REJECT','OVERRIDE')),
    override_reason          TEXT,
    reviewed_at               TIMESTAMPTZ
);
CREATE INDEX idx_eval_candidate ON evaluation_results(candidate_id);
CREATE INDEX idx_eval_status ON evaluation_results(status);
CREATE INDEX idx_eval_rule ON evaluation_results(rule_id);

CREATE TABLE scoring_results (
    scoring_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id           TEXT NOT NULL REFERENCES candidates(candidate_id),
    rule_pack_version_id   UUID NOT NULL REFERENCES rule_pack_versions(version_id),
    total_score            NUMERIC NOT NULL,
    breakdown              JSONB NOT NULL,
    rank                   INTEGER,
    computed_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_scoring_candidate ON scoring_results(candidate_id);
CREATE INDEX idx_scoring_rank ON scoring_results(rank);

CREATE TABLE verification_results (
    verification_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id      TEXT NOT NULL REFERENCES candidates(candidate_id),
    source            TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('Verified','Failed','Manual Review','Pending')),
    details           JSONB,
    checked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    signed_off_by       UUID REFERENCES users(user_id),
    signed_off_at        TIMESTAMPTZ
);

CREATE TABLE communication_log (
    message_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id   TEXT NOT NULL REFERENCES candidates(candidate_id),
    channel        TEXT NOT NULL CHECK (channel IN ('SMS','EMAIL','WHATSAPP')),
    template_code  TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('SENT','FAILED','RETRIED','DELIVERED')),
    triggered_by   UUID REFERENCES users(user_id),
    sent_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE appeals (
    appeal_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id    TEXT NOT NULL REFERENCES candidates(candidate_id),
    reason_text     TEXT,
    category        TEXT CHECK (category IN
                     ('Data Error','Rule Misapplication','Document Update','Quota Dispute')),
    status          TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN
                     ('SUBMITTED','TRIAGED','UNDER_REVIEW','RESOLVED')),
    assigned_to     UUID REFERENCES users(user_id),
    resolution      TEXT,
    resolved_at       TIMESTAMPTZ,
    submitted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orchestrator HIL blocking points (persisted so pipeline state survives
-- restarts across multi-hour/multi-day human review windows)
CREATE TABLE gate_events (
    gate_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id     TEXT NOT NULL,
    gate_type    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED')),
    payload      JSONB,
    resolved_by  UUID REFERENCES users(user_id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ
);
CREATE INDEX idx_gate_batch ON gate_events(batch_id, status);
