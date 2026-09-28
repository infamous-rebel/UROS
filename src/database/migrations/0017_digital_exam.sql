-- 0017_digital_exam.sql
-- Feature 3: Digital Exam Paper Creator
-- Deterministic exam assembly and scoring — no ML/LLM. MCQ questions are
-- auto-scored against a plain answer key with visible marks/negative
-- marking, exactly like the MCQ Scanner (Feature 2). Short-answer
-- questions cannot be graded deterministically without a model, so they
-- are never auto-scored; a submission containing one is always routed
-- to a human grader (needs_review=true) rather than guessed. Publishing
-- an exam is a mandatory human approval gate, snapshotted for version
-- history/rollback.

CREATE TABLE digital_exams (
    exam_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                   UUID NOT NULL REFERENCES organizations(org_id),
    title                     TEXT NOT NULL,
    description                TEXT,
    header_logo                  TEXT, -- file path/URL to org logo, shown on exported paper
    date                            DATE,
    duration_minutes                  INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
    status                              TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                                        ('DRAFT','PENDING_APPROVAL','PUBLISHED','ARCHIVED')),
    -- Additive, documented extensions beyond the spec's literal column
    -- list — required to satisfy "Support version history and human
    -- approval gates" and the guided builder's persona pre-fill:
    version                              INTEGER NOT NULL DEFAULT 1,
    persona_id                              UUID REFERENCES personas(persona_id), -- optional: guided builder "choose persona -> pre-fill topics"
    total_marks                              NUMERIC NOT NULL DEFAULT 0, -- cached sum of question marks, recomputed on every question change
    approved_by                                UUID REFERENCES users(user_id),
    approved_at                                  TIMESTAMPTZ,
    created_by                                    UUID REFERENCES users(user_id),
    created_at                                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_digital_exams_org ON digital_exams(org_id, status);

CREATE TABLE exam_sections (
    section_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id            UUID NOT NULL REFERENCES digital_exams(exam_id),
    section_name         TEXT NOT NULL,
    order_index             INTEGER NOT NULL DEFAULT 1,
    -- Additive: ties a section to the guided builder's topic/weight
    -- inputs ("select topics -> adjust weights"); both optional.
    topic                     TEXT,
    weight                      NUMERIC CHECK (weight IS NULL OR (weight >= 0 AND weight <= 100))
);
CREATE INDEX idx_exam_sections_exam ON exam_sections(exam_id, order_index);

-- Reusable, org-wide question bank — "Maintain question bank and reuse
-- past questions" (Master Feature Doc, Feature 3 Configurable
-- Experience). Additive table beyond the spec's literal 4; referenced by
-- exam_questions.bank_question_id below. Declared before exam_questions
-- so the forward FK reference resolves.
CREATE TABLE exam_question_bank (
    bank_question_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID NOT NULL REFERENCES organizations(org_id),
    question_type             TEXT NOT NULL CHECK (question_type IN ('MCQ','SHORT_ANSWER')),
    question_text               TEXT NOT NULL,
    options                        JSONB,
    correct_answer                   TEXT,
    marks                              NUMERIC NOT NULL DEFAULT 1 CHECK (marks >= 0),
    negative_mark                        NUMERIC NOT NULL DEFAULT 0 CHECK (negative_mark >= 0),
    topic                                  TEXT,
    created_by                                UUID REFERENCES users(user_id),
    created_at                                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_question_bank_org ON exam_question_bank(org_id, topic);

CREATE TABLE exam_questions (
    question_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    section_id            UUID NOT NULL REFERENCES exam_sections(section_id),
    question_type           TEXT NOT NULL CHECK (question_type IN ('MCQ','SHORT_ANSWER')),
    question_text             TEXT NOT NULL,
    options                      JSONB, -- MCQ only: [{"key":"A","text":"..."}, ...]; NULL for SHORT_ANSWER
    correct_answer                 TEXT, -- MCQ: option key (e.g. "A"); SHORT_ANSWER: NULL (no deterministic auto-grade — see module docstring)
    marks                            NUMERIC NOT NULL DEFAULT 1 CHECK (marks >= 0),
    negative_mark                       NUMERIC NOT NULL DEFAULT 0 CHECK (negative_mark >= 0),
    order_index                           INTEGER NOT NULL DEFAULT 1,
    -- Additive: provenance for "question bank and reuse" / "parse
    -- uploaded exam paper" — every question card in the UI shows where
    -- it came from, never silently.
    source                                   TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','QUESTION_BANK','PARSED')),
    bank_question_id                            UUID REFERENCES exam_question_bank(bank_question_id)
);
CREATE INDEX idx_exam_questions_section ON exam_questions(section_id, order_index);

CREATE TABLE digital_exam_submissions (
    submission_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id               UUID NOT NULL REFERENCES digital_exams(exam_id),
    candidate_id             TEXT REFERENCES candidates(candidate_id),
    answers                     JSONB NOT NULL, -- [{"question_id":"...","answer":"A" | "free text"}]
    score                         NUMERIC, -- NULL until scored; auto MCQ score only until any short-answer grades are added
    status                          TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN
                                    ('SUBMITTED','SCORED','NEEDS_REVIEW','GRADED')),
    -- Additive: short-answer questions force human grading — never
    -- silently scored 0 or guessed by a model.
    needs_review                       BOOLEAN NOT NULL DEFAULT false,
    -- Global requirement: every stored result carries a machine-readable
    -- reason_code plus a plain-language reason_description alongside its
    -- evidence, never just a bare number.
    reason_code                          TEXT,
    reason_description                     TEXT,
    score_breakdown                       JSONB, -- per-question evidence: reason_code, reason_description, evidence (question/answer/marks/rule), awarded marks
    graded_by                                UUID REFERENCES users(user_id),
    graded_at                                 TIMESTAMPTZ,
    submitted_at                               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_digital_exam_submissions_exam ON digital_exam_submissions(exam_id, status);
CREATE INDEX idx_digital_exam_submissions_candidate ON digital_exam_submissions(candidate_id);

-- Version history / rollback — snapshotted on every publish (the human
-- approval gate), never on every draft edit, so history reflects
-- meaningful, approved milestones. Additive table beyond the spec's
-- literal 4, required by "Support version history and human approval
-- gates".
CREATE TABLE digital_exam_versions (
    version_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id             UUID NOT NULL REFERENCES digital_exams(exam_id),
    version               INTEGER NOT NULL,
    snapshot                JSONB NOT NULL, -- full exam+sections+questions at publish time
    published_by              UUID REFERENCES users(user_id),
    published_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_digital_exam_versions_unique ON digital_exam_versions(exam_id, version);
