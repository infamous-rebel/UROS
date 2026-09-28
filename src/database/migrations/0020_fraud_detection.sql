-- 0020_fraud_detection.sql
-- Feature 6: Fraud & Inconsistency Detection
-- Deterministic cross-document validation. Agents only ever flag a
-- candidate for human review here — nothing in this migration or the
-- feature it supports ever writes candidates.status, matching the
-- "recommendation only" contract already established by
-- eligibility_agent/dimension_scoring_agent. A fraud_checks row may be
-- marked is_knockout=true purely as UI/config metadata (surfaced so a
-- human reviewer knows a confirmed flag on that check is meant to be
-- treated as disqualifying); the system itself never auto-rejects.

CREATE TABLE fraud_checks (
    check_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(org_id),
    name          TEXT NOT NULL,
    check_type    TEXT NOT NULL CHECK (check_type IN (
                      'AGE_EDUCATION_TIMELINE',
                      'CGPA_DIVISION_CONSISTENCY',
                      'EXPERIENCE_OVERLAP',
                      'DUPLICATE_IDENTITY',
                      'IMPOSSIBLE_DOB_GRADUATION_AGE'
                  )),
    config        JSONB NOT NULL DEFAULT '{}'::jsonb, -- tolerances/thresholds; see fraud_detection_agent DEFAULT_CHECK_CONFIGS for shape+defaults
    is_knockout   BOOLEAN NOT NULL DEFAULT false,      -- metadata only; a human still confirms before any downstream rejection
    active        BOOLEAN NOT NULL DEFAULT true,
    created_by    UUID REFERENCES users(user_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one ACTIVE configuration per (org, check_type) — mirrors the
-- dimension_configs versioning pattern: POST /fraud/configure deactivates
-- the prior active row for that check_type rather than mutating it.
CREATE UNIQUE INDEX uq_fraud_checks_active_type
    ON fraud_checks(org_id, check_type)
    WHERE active = true;
CREATE INDEX idx_fraud_checks_org ON fraud_checks(org_id, active);

CREATE TABLE fraud_flags (
    flag_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES organizations(org_id),
    candidate_id        TEXT NOT NULL REFERENCES candidates(candidate_id),
    check_id            UUID REFERENCES fraud_checks(check_id), -- NULL when the check ran using a system default (never explicitly configured by the org)
    check_type          TEXT NOT NULL CHECK (check_type IN (
                            'AGE_EDUCATION_TIMELINE',
                            'CGPA_DIVISION_CONSISTENCY',
                            'EXPERIENCE_OVERLAP',
                            'DUPLICATE_IDENTITY',
                            'IMPOSSIBLE_DOB_GRADUATION_AGE'
                        )),
    severity            TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
    reason_code         TEXT NOT NULL,
    reason_description  TEXT NOT NULL,
    evidence            JSONB NOT NULL, -- the exact extracted values/rule/config that produced this flag (Global Reasoning Standard)
    status              TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED','FALSE_POSITIVE','ESCALATED')),
    detected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by         UUID REFERENCES users(user_id),
    reviewed_at         TIMESTAMPTZ,
    resolution          TEXT CHECK (resolution IN ('CONFIRMED','FALSE_POSITIVE','ESCALATED')),
    resolution_reason   TEXT
);
CREATE INDEX idx_fraud_flags_candidate ON fraud_flags(candidate_id, detected_at DESC);
CREATE INDEX idx_fraud_flags_org_status ON fraud_flags(org_id, status);
CREATE INDEX idx_fraud_flags_check ON fraud_flags(check_id);

-- Duplicate-identity detection (Check D) needs to find other candidates
-- in the same org sharing a national_id/phone/email quickly even at
-- 100K+ applicants; candidates.national_id/phone_primary/email had no
-- indexes prior to this feature. Partial (WHERE ... IS NOT NULL) to
-- keep the indexes small since most lookups only care about non-null
-- identity fields.
CREATE INDEX idx_candidates_national_id ON candidates(org_id, national_id) WHERE national_id IS NOT NULL;
CREATE INDEX idx_candidates_phone_primary ON candidates(org_id, phone_primary) WHERE phone_primary IS NOT NULL;
CREATE INDEX idx_candidates_email ON candidates(org_id, lower(email)) WHERE email IS NOT NULL;
