-- 0002_rule_packs.sql
CREATE TABLE rule_packs (
    rule_pack_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(org_id),
    name            TEXT NOT NULL,
    sector          TEXT NOT NULL,
    circular_id     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT false,
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rule_pack_versions (
    version_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_pack_id    UUID NOT NULL REFERENCES rule_packs(rule_pack_id),
    version_number  INTEGER NOT NULL,
    change_summary  TEXT,
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (rule_pack_id, version_number)
);

CREATE TABLE rules (
    rule_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_pack_version_id     UUID NOT NULL REFERENCES rule_pack_versions(version_id),
    rule_code                TEXT NOT NULL,
    rule_type                TEXT NOT NULL CHECK (rule_type IN
                              ('ELIGIBILITY','QUOTA','SCORING','KNOCKOUT',
                               'WORKFLOW','COMMUNICATION','VERIFICATION')),
    field_path                TEXT NOT NULL,
    operator                  TEXT NOT NULL CHECK (operator IN
                               ('EQ','NEQ','LT','LTE','GT','GTE','IN','NOT_IN','REGEX')),
    threshold_type             TEXT NOT NULL DEFAULT 'exact'
                                CHECK (threshold_type IN ('exact','numeric_band')),
    threshold_value            JSONB NOT NULL,
    review_margin              NUMERIC,
    min_confidence_threshold   NUMERIC DEFAULT 0.85,
    fail_reason_code           TEXT NOT NULL,
    is_knockout                BOOLEAN NOT NULL DEFAULT false,
    weight                     NUMERIC,
    active                     BOOLEAN NOT NULL DEFAULT true,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rules_pack_version ON rules(rule_pack_version_id);
CREATE INDEX idx_rules_type ON rules(rule_type);
