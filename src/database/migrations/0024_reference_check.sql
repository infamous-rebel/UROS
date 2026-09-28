-- Feature 7: Automated Reference Checking
--
-- UROS sends structured, persona-mapped reference questionnaires to referees
-- (email/WhatsApp), parses and scores responses deterministically, and
-- always routes the final decision to a human reviewer (UROS_Global_
-- Reasoning_Standard.md: "No result may exist without reasoning").
--
-- Tables (per spec):
--   reference_requests   - one row per referee invitation for a candidate
--   reference_responses  - one row per answered question on a request
--   reference_results    - one row per scored/reviewed request
--
-- Additive table beyond the literal spec (documented, mirrors the
-- versioned-config pattern already used by fraud_checks / dimension
-- configs / persona_requirements): reference_question_sets. The
-- "configure" endpoint (POST /api/v1/references/configure) has to persist
-- the persona-mapped question set *somewhere* so that later requests and
-- scoring can replay the exact questions/weights that were active at
-- send time; a JSONB blob on reference_requests alone would not support
-- versioning or reuse across candidates for the same persona.

-- ---------------------------------------------------------------------
-- reference_question_sets
-- ---------------------------------------------------------------------
CREATE TABLE reference_question_sets (
    question_set_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(org_id),
    persona_id      UUID REFERENCES personas(persona_id), -- NULL = org-wide default set
    name            TEXT NOT NULL,
    -- Array of { question_id: string, text: string, type: 'RATING_1_5'|'YES_NO'|'TEXT', weight: number }
    -- type governs deterministic scoring in reference_check_agent:
    --   RATING_1_5 / YES_NO are auto-scored; TEXT is never auto-scored
    --   (evidence only, always routed to human review), mirroring the
    --   digital-exam short-answer pattern (Feature: Digital Exam Paper Creator).
    questions       JSONB NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    active          BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reference_question_sets_questions_not_empty
        CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) > 0)
);

-- Only one active question set per (org, persona) at a time. A NULL
-- persona_id represents the org-wide default set, so it is coalesced
-- into the uniqueness key alongside the real persona UUIDs.
CREATE UNIQUE INDEX idx_reference_question_sets_active_per_persona
    ON reference_question_sets (org_id, COALESCE(persona_id::text, 'default'))
    WHERE active;

CREATE INDEX idx_reference_question_sets_org ON reference_question_sets(org_id);

-- ---------------------------------------------------------------------
-- reference_requests
-- ---------------------------------------------------------------------
CREATE TABLE reference_requests (
    request_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(org_id),
    candidate_id     TEXT NOT NULL REFERENCES candidates(candidate_id),
    referee_email    TEXT,
    referee_phone    TEXT,
    persona_id       UUID REFERENCES personas(persona_id),
    question_set_id  UUID NOT NULL REFERENCES reference_question_sets(question_set_id),
    status           TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','SENT','COMPLETED','EXPIRED','CANCELLED')),
    -- SHA-256(token + JWT_SECRET pepper), never the plaintext bearer token.
    -- The plaintext is returned once from POST /references/request and
    -- delivered to the referee via the Communication Hub link; it is
    -- never persisted, mirroring the OTP hashing pattern in
    -- applicant_portal_agent (hashOtp / OTP_PEPPER).
    token            TEXT NOT NULL,
    expires_at       TIMESTAMPTZ NOT NULL,
    created_by       UUID REFERENCES users(user_id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at          TIMESTAMPTZ,
    reminder_count   INTEGER NOT NULL DEFAULT 0,
    completed_at     TIMESTAMPTZ,
    CONSTRAINT reference_requests_referee_contact_required
        CHECK (referee_email IS NOT NULL OR referee_phone IS NOT NULL)
);

CREATE UNIQUE INDEX idx_reference_requests_token ON reference_requests(token);
CREATE INDEX idx_reference_requests_candidate ON reference_requests(candidate_id);
CREATE INDEX idx_reference_requests_org_status ON reference_requests(org_id, status);

-- ---------------------------------------------------------------------
-- reference_responses
-- ---------------------------------------------------------------------
CREATE TABLE reference_responses (
    response_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id    UUID NOT NULL REFERENCES reference_requests(request_id),
    question_id   TEXT NOT NULL, -- matches a question_id inside reference_question_sets.questions
    response_text TEXT,
    score         NUMERIC,       -- NULL until scored; always NULL for TEXT-type questions
    confidence    NUMERIC,       -- NULL until scored; 0..1
    -- UROS_Global_Reasoning_Standard.md: no result may exist without reasoning.
    reason_code        TEXT,
    reason_description TEXT,
    evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reference_responses_unique_question UNIQUE (request_id, question_id)
);

CREATE INDEX idx_reference_responses_request ON reference_responses(request_id);

-- ---------------------------------------------------------------------
-- reference_results
-- ---------------------------------------------------------------------
CREATE TABLE reference_results (
    result_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL UNIQUE REFERENCES reference_requests(request_id),
    candidate_id    TEXT NOT NULL REFERENCES candidates(candidate_id),
    org_id          UUID NOT NULL REFERENCES organizations(org_id),
    total_score     NUMERIC NOT NULL,
    max_score       NUMERIC NOT NULL,
    -- Agent-produced suggestion ONLY. Never a final decision
    -- (UROS_Global_Reasoning_Standard.md / Core Principle: HIL).
    recommendation  TEXT NOT NULL CHECK (recommendation IN ('RECOMMEND','NEEDS_REVIEW','CONCERN')),
    reason_code         TEXT NOT NULL,
    reason_description  TEXT NOT NULL,
    evidence             JSONB NOT NULL DEFAULT '{}'::jsonb,
    reviewer_id     UUID REFERENCES users(user_id),
    review_decision TEXT CHECK (review_decision IN ('APPROVED','REJECTED','ESCALATED')),
    review_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at     TIMESTAMPTZ,
    CONSTRAINT reference_results_review_reason_required
        CHECK (review_decision IS NULL OR (review_reason IS NOT NULL AND length(trim(review_reason)) > 0))
);

CREATE INDEX idx_reference_results_candidate ON reference_results(candidate_id);
CREATE INDEX idx_reference_results_org ON reference_results(org_id);
