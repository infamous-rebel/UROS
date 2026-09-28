-- Feature 10: Candidate Rediscovery / Talent Pool Re-engagement
--
-- Matches previously REJECTED/WITHDRAWN candidates against a new
-- circular/persona using the existing Dimension Scoring Agent
-- (assembleCandidateProfile) and Persona Agent (evaluateFit). The
-- rediscovery_agent NEVER auto-invites or auto-shortlists — it only
-- ever writes a PENDING_REVIEW suggestion row; a human must APPROVE it
-- before any outreach can be sent (UROS_Global_Reasoning_Standard.md:
-- "Agents may suggest, but never finalize").
--
-- Tables (per spec): rediscovery_consents, rediscovery_suggestions,
-- rediscovery_outreach.

-- ---------------------------------------------------------------------
-- rediscovery_consents
-- ---------------------------------------------------------------------
-- One row per candidate: the latest known consent state for being
-- re-contacted about future circulars. Upserted in place (not
-- versioned) — the audit_log already captures the full history of every
-- opt-in/opt-out transition via logAudit(), so this table only needs to
-- answer "what does the candidate want right now".
CREATE TABLE rediscovery_consents (
    consent_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id  TEXT NOT NULL REFERENCES candidates(candidate_id),
    org_id        UUID NOT NULL REFERENCES organizations(org_id),
    opted_in      BOOLEAN NOT NULL,
    opted_in_at   TIMESTAMPTZ,
    opted_out_at  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Exactly one consent record per candidate — POST /rediscovery/consent
    -- upserts this row rather than appending a new one each time.
    CONSTRAINT rediscovery_consents_one_per_candidate UNIQUE (candidate_id),
    -- opted_in_at is set exactly when the record represents an opt-in;
    -- opted_out_at exactly when it represents an opt-out. Never both,
    -- never neither, for the currently-recorded direction — this mirrors
    -- offboarding_steps' approval_reason CHECK in spirit: the state must
    -- carry evidence of when it took effect.
    CONSTRAINT rediscovery_consents_timestamp_matches_state
        CHECK (
            (opted_in = true  AND opted_in_at  IS NOT NULL) OR
            (opted_in = false AND opted_out_at IS NOT NULL)
        )
);
CREATE INDEX idx_rediscovery_consents_org ON rediscovery_consents(org_id, opted_in);

-- ---------------------------------------------------------------------
-- rediscovery_suggestions
-- ---------------------------------------------------------------------
-- One row per (candidate, target_circular_id) match the agent proposes.
-- Never created above the org's configured min_fit_score, never for a
-- candidate excluded by consent/fraud/cooldown rules (see
-- rediscovery_agent.filterEligibleCandidates) — the deterministic
-- eligibility gate runs BEFORE a row is ever written, not after.
CREATE TABLE rediscovery_suggestions (
    suggestion_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES organizations(org_id),
    candidate_id        TEXT NOT NULL REFERENCES candidates(candidate_id),
    target_circular_id  TEXT NOT NULL,
    target_position     TEXT,
    fit_score           NUMERIC NOT NULL CHECK (fit_score >= 0 AND fit_score <= 100),
    reason_code         TEXT NOT NULL,
    reason_description  TEXT NOT NULL,
    evidence            JSONB NOT NULL, -- fit breakdown, matched/unmatched requirements, exclusion checks passed (Global Reasoning Standard)
    status              TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
                            CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by         UUID REFERENCES users(user_id),
    reviewed_at         TIMESTAMPTZ,
    review_reason       TEXT,
    -- Idempotent reruns: matching the same candidate against the same
    -- circular twice must never create a duplicate suggestion.
    CONSTRAINT rediscovery_suggestions_unique_candidate_circular
        UNIQUE (candidate_id, target_circular_id),
    -- Mirrors offboarding_steps_approval_requires_reason: a reviewed
    -- suggestion (APPROVED/REJECTED) must carry a human-readable reason;
    -- an untouched PENDING_REVIEW row must not.
    CONSTRAINT rediscovery_suggestions_review_requires_reason
        CHECK (
            (status = 'PENDING_REVIEW' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL)
            OR
            (status IN ('APPROVED','REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
             AND review_reason IS NOT NULL AND length(trim(review_reason)) > 0)
        )
);
CREATE INDEX idx_rediscovery_suggestions_org_circular ON rediscovery_suggestions(org_id, target_circular_id, status);
CREATE INDEX idx_rediscovery_suggestions_candidate ON rediscovery_suggestions(candidate_id);
CREATE INDEX idx_rediscovery_suggestions_status ON rediscovery_suggestions(org_id, status);

-- ---------------------------------------------------------------------
-- rediscovery_outreach
-- ---------------------------------------------------------------------
-- One row per re-engagement message actually sent for an APPROVED
-- suggestion. Distinct from the generic `communication_log` table
-- (which the Communication Hub also writes to for every message it
-- sends, Feature 10 included): this table tracks the rediscovery
-- campaign's own outcome — whether the candidate responded with
-- interest — which communication_log has no column for.
CREATE TABLE rediscovery_outreach (
    outreach_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    suggestion_id    UUID NOT NULL REFERENCES rediscovery_suggestions(suggestion_id),
    channel          TEXT NOT NULL CHECK (channel IN ('SMS','EMAIL','WHATSAPP')),
    template_code    TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT','FAILED')),
    sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    response_status  TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (response_status IN ('PENDING','INTERESTED','NOT_INTERESTED','NO_RESPONSE')),
    responded_at     TIMESTAMPTZ
);
-- rediscovery_outreach intentionally has no org_id column, mirroring
-- offboarding_steps (0026): every query MUST join through
-- rediscovery_suggestions.org_id — never trust suggestion_id alone.
CREATE INDEX idx_rediscovery_outreach_suggestion ON rediscovery_outreach(suggestion_id);
CREATE INDEX idx_rediscovery_outreach_status ON rediscovery_outreach(status, response_status);
