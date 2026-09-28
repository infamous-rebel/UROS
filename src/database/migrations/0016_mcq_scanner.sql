-- 0016_mcq_scanner.sql
-- Feature 2: Paper-Based MCQ Scanner
-- Deterministic OMR-style bubble/mark detection against a configurable
-- answer sheet template — no ML/LLM. Every detected answer carries a
-- confidence value and, when ambiguous, is routed to a human reviewer.
-- Scoring is a plain formula (marks_per_question, negative_mark) with
-- every term visible in mcq_results — nothing hidden.

CREATE TABLE mcq_exams (
    exam_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                 UUID NOT NULL REFERENCES organizations(org_id),
    name                    TEXT NOT NULL,
    date                     DATE,
    total_questions           INTEGER NOT NULL CHECK (total_questions > 0),
    marks_per_question         NUMERIC NOT NULL DEFAULT 1,
    negative_mark                NUMERIC NOT NULL DEFAULT 0, -- deducted per wrong answer; 0 = no negative marking
    -- Extension beyond the spec's literal column list, both optional and
    -- additive: an answer sheet template (roll/ID zone + per-question
    -- option zones) is required to make bubble detection deterministic
    -- and configurable per Master Feature Doc "Configurable Experience:
    -- Define answer sheet template...". NULL until POST /mcq/configure
    -- sets it. A pass threshold is likewise optional; mcq_results.passed
    -- stays NULL until one is configured.
    answer_sheet_template         JSONB,
    pass_threshold                  NUMERIC,
    created_by                       UUID REFERENCES users(user_id),
    created_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mcq_exams_org ON mcq_exams(org_id);

-- Answer key is versioned like rule packs: a new POST /mcq/configure call
-- for an exam inserts a new version and marks prior key rows inactive,
-- never mutates a published key in place (audit-safe).
CREATE TABLE mcq_answer_keys (
    answer_key_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id             UUID NOT NULL REFERENCES mcq_exams(exam_id),
    question_no          INTEGER NOT NULL CHECK (question_no > 0),
    correct_option         TEXT NOT NULL CHECK (correct_option IN ('A','B','C','D','E')),
    version                  INTEGER NOT NULL DEFAULT 1,
    active                     BOOLEAN NOT NULL DEFAULT true,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_mcq_answer_keys_active ON mcq_answer_keys(exam_id, question_no, version);
CREATE INDEX idx_mcq_answer_keys_exam_active ON mcq_answer_keys(exam_id, active);

-- One row per uploaded scanned sheet (a single page image, or a page
-- extracted from a ZIP batch). candidate_id is nullable — roll/ID
-- detection may fail or not yet be matched to a candidate record, in
-- which case the sheet is routed to human review rather than silently
-- dropped or guessed.
CREATE TABLE mcq_answer_sheets (
    sheet_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id               UUID NOT NULL REFERENCES mcq_exams(exam_id),
    candidate_id            TEXT REFERENCES candidates(candidate_id),
    roll_no                   TEXT, -- as detected (or corrected by a human) from the roll zone
    file_path                   TEXT NOT NULL,
    status                        TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (status IN
                                  ('UPLOADED','PROCESSING','PROCESSED','NEEDS_REVIEW','CONFIRMED','REJECTED','RESCAN_REQUESTED')),
    roll_detection_confidence       NUMERIC,
    processing_error                  TEXT, -- set on PDF-rasterization-not-implemented / unreadable file, etc. — never crashes the batch
    reviewed_by                         UUID REFERENCES users(user_id),
    review_reason                        TEXT,
    uploaded_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at                            TIMESTAMPTZ,
    reviewed_at                              TIMESTAMPTZ
);
CREATE INDEX idx_mcq_sheets_exam ON mcq_answer_sheets(exam_id, status);
CREATE INDEX idx_mcq_sheets_candidate ON mcq_answer_sheets(candidate_id);

-- One row per detected question-answer per sheet — the evidence panel
-- for a flagged sheet is exactly these rows.
CREATE TABLE mcq_sheet_answers (
    sheet_answer_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id              UUID NOT NULL REFERENCES mcq_answer_sheets(sheet_id),
    question_no             INTEGER NOT NULL CHECK (question_no > 0),
    detected_option            TEXT CHECK (detected_option IN ('A','B','C','D','E')), -- NULL = skipped/unreadable
    confidence                   NUMERIC NOT NULL, -- 0-1, mark-density separation between top and next-best option
    status                         TEXT NOT NULL DEFAULT 'DETECTED' CHECK (status IN
                                    ('DETECTED','LOW_CONFIDENCE','MULTIPLE_MARKS','MISSING','CORRECTED')),
    corrected_option                  TEXT CHECK (corrected_option IN ('A','B','C','D','E')), -- set only by a human review PATCH
    created_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_mcq_sheet_answers_unique ON mcq_sheet_answers(sheet_id, question_no);
CREATE INDEX idx_mcq_sheet_answers_sheet ON mcq_sheet_answers(sheet_id);

-- One row per scored sheet. Recomputed (upsert) whenever a sheet is
-- (re)scored or a human correction changes an answer — status/needs_review
-- always reflect the current, human-visible state, never a stale one.
CREATE TABLE mcq_results (
    result_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id              UUID NOT NULL UNIQUE REFERENCES mcq_answer_sheets(sheet_id),
    candidate_id             TEXT REFERENCES candidates(candidate_id),
    correct_count               INTEGER NOT NULL DEFAULT 0,
    wrong_count                    INTEGER NOT NULL DEFAULT 0,
    skipped_count                     INTEGER NOT NULL DEFAULT 0,
    negative_total                       NUMERIC NOT NULL DEFAULT 0,
    final_score                             NUMERIC NOT NULL DEFAULT 0,
    passed                                    BOOLEAN, -- NULL until the exam has a pass_threshold configured
    needs_review                                BOOLEAN NOT NULL DEFAULT false,
    created_at                                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mcq_results_sheet ON mcq_results(sheet_id);
CREATE INDEX idx_mcq_results_candidate ON mcq_results(candidate_id);
