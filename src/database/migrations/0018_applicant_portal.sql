-- 0018_applicant_portal.sql
-- Feature 4: Applicant Status Portal
-- Read-only public portal for applicants to check their own application
-- status using their existing candidate_id. No new decision logic is
-- introduced here — the portal only presents evaluation_results/
-- candidate data that other agents already produced, deterministically
-- formatted with reason_code + reason_description + evidence per the
-- Global Reasoning Standard, and gated by org-level visibility config.
--
-- Two tables are the minimum necessary addition:
--   1. applicant_otp_requests — short-lived, hashed OTP codes for
--      applicant login (reuses the existing Communication Hub to
--      deliver the code; never stores the plaintext code).
--   2. applicant_portal_configs — per-org visibility/localization
--      settings (which reason codes are shown, timeline text, appeal
--      toggle), matching Master Feature Doc Feature 4's "Configurable
--      Experience" bullets.

CREATE TABLE applicant_otp_requests (
    request_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id     TEXT NOT NULL REFERENCES candidates(candidate_id),
    channel            TEXT NOT NULL CHECK (channel IN ('EMAIL','SMS')),
    code_hash            TEXT NOT NULL, -- sha256(code + server pepper); the plaintext code is never persisted
    expires_at             TIMESTAMPTZ NOT NULL,
    consumed_at              TIMESTAMPTZ,
    attempts                   INTEGER NOT NULL DEFAULT 0,
    max_attempts                 INTEGER NOT NULL DEFAULT 5,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_applicant_otp_candidate ON applicant_otp_requests(candidate_id, created_at DESC);

CREATE TABLE applicant_portal_configs (
    org_id                    UUID PRIMARY KEY REFERENCES organizations(org_id),
    -- NULL = show every reason code the applicant's own evaluations
    -- produced (the default, matching UROS_08_Trust_Fairness_Transparency:
    -- "Every rejection carries a specific reason code"). A non-null,
    -- non-empty array restricts the portal to only that allowlist.
    visible_reason_codes        TEXT[],
    estimated_timeline_text        TEXT NOT NULL DEFAULT 'Updates are typically posted within 2-3 weeks of each stage.',
    appeal_enabled                    BOOLEAN NOT NULL DEFAULT true,
    -- {"bn": {"estimated_timeline_text": "...", "next_update_text": "..."}, ...}
    -- keyed by language code; default_language selects which (if any)
    -- override is applied. English always falls back to the columns above.
    localized_messages                  JSONB NOT NULL DEFAULT '{}'::jsonb,
    default_language                       TEXT NOT NULL DEFAULT 'en',
    updated_by                                UUID REFERENCES users(user_id),
    updated_at                                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
