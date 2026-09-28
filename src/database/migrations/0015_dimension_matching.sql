-- 0015_dimension_matching.sql
-- Feature 1: 7-Dimension Candidate Matching System
-- Deterministic, configurable, human-in-the-loop. No black-box scoring:
-- every dimension is a named set of rule-engine sub-criteria (same
-- operator set as eligibility/persona rules), weights are visible, and
-- the overall fit score is a plain weighted sum. Agents only suggest;
-- candidate_dimension_scores.status only moves past CALCULATED via a
-- human decision (see PATCH /candidates/:id/dimension-scores/:evaluation_id).

-- Dimension templates: reusable starting points for an org's dimension
-- set. Built-in templates (org_id IS NULL) ship with UROS; orgs may also
-- save their own as private templates. Templates only carry metadata —
-- the actual dimension definitions they seed are dimension_configs rows
-- with org_id IS NULL, keyed by template_id (see seed data below).
CREATE TABLE dimension_templates (
    template_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID REFERENCES organizations(org_id), -- NULL = built-in, available to all orgs
    code          TEXT NOT NULL,                          -- e.g. UROS_CORE_7, INDUSTRY_7
    name          TEXT NOT NULL,
    description   TEXT,
    is_builtin    BOOLEAN NOT NULL DEFAULT false,
    created_by    UUID REFERENCES users(user_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_dimension_templates_code ON dimension_templates(code, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_dimension_templates_org ON dimension_templates(org_id);

-- One row per dimension in an active (or template-default) configuration.
-- org_id IS NULL rows are a template's own default dimension set, seeded
-- once and never scored directly. org_id IS NOT NULL rows are an
-- organisation's own configured dimensions (cloned from a template and/or
-- hand-edited), optionally scoped to a persona/job family.
CREATE TABLE dimension_configs (
    dimension_config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID REFERENCES organizations(org_id),      -- NULL = template default
    template_id          UUID REFERENCES dimension_templates(template_id),
    persona_id            UUID REFERENCES personas(persona_id),        -- NULL = org-wide default set
    dimension_key         TEXT NOT NULL,                                -- stable machine key, e.g. EDUCATION
    dimension_name         TEXT NOT NULL,                                -- human-editable display name
    sequence                INTEGER NOT NULL DEFAULT 1,
    weight                  NUMERIC NOT NULL CHECK (weight >= 0 AND weight <= 100),
    is_knockout              BOOLEAN NOT NULL DEFAULT false,
    knockout_threshold        NUMERIC CHECK (knockout_threshold IS NULL OR (knockout_threshold >= 0 AND knockout_threshold <= 100)),
    version                    INTEGER NOT NULL DEFAULT 1,
    active                      BOOLEAN NOT NULL DEFAULT true,
    created_by                  UUID REFERENCES users(user_id),
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dimension_configs_org_active ON dimension_configs(org_id, persona_id, active);
CREATE INDEX idx_dimension_configs_template ON dimension_configs(template_id);

-- Sub-criteria within a dimension. Reuses the same deterministic operator
-- set as the eligibility rule engine (src/rules/engine/operators.ts) so
-- there is exactly one evaluation semantics in the whole system.
CREATE TABLE dimension_subcriteria (
    subcriterion_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dimension_config_id UUID NOT NULL REFERENCES dimension_configs(dimension_config_id),
    field_path            TEXT NOT NULL,     -- dotted path into the candidate profile, e.g. academic.hsc.cgpa
    label                   TEXT NOT NULL,     -- plain-language label, e.g. "HSC CGPA"
    operator                 TEXT NOT NULL CHECK (operator IN ('EQ','NEQ','LT','LTE','GT','GTE','IN','NOT_IN','REGEX')),
    threshold_value            JSONB NOT NULL,
    weight                      NUMERIC NOT NULL DEFAULT 0 CHECK (weight >= 0), -- normalized to 100 within the dimension at scoring time
    evidence_doc_type            TEXT,          -- what document proves this, shown in the evidence panel
    reason_code                   TEXT NOT NULL, -- attached when this sub-criterion is not matched
    active                          BOOLEAN NOT NULL DEFAULT true,
    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dimension_subcriteria_config ON dimension_subcriteria(dimension_config_id);

-- One row per scoring run for a candidate. Stores the full, visible
-- breakdown (per dimension, per sub-criterion) so every number on the
-- Dimension Scorecard traces back to a rule and an extracted value —
-- never a hidden score. Human approval is mandatory before the result
-- is treated as final anywhere else in the pipeline.
CREATE TABLE candidate_dimension_scores (
    evaluation_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id          TEXT NOT NULL REFERENCES candidates(candidate_id),
    org_id                  UUID NOT NULL REFERENCES organizations(org_id),
    persona_id               UUID REFERENCES personas(persona_id),
    template_id               UUID REFERENCES dimension_templates(template_id),
    overall_fit_score           NUMERIC NOT NULL CHECK (overall_fit_score >= 0 AND overall_fit_score <= 100),
    dimension_breakdown           JSONB NOT NULL, -- [{dimension_key, dimension_name, weight, raw_score, weighted_score, knockout, subcriteria:[...]}]
    recommended_decision           TEXT NOT NULL CHECK (recommended_decision IN ('AUTO_PASS','NEEDS_REVIEW','AUTO_FAIL')),
    knockout_triggered               BOOLEAN NOT NULL DEFAULT false,
    knockout_reason                   TEXT,
    status                              TEXT NOT NULL DEFAULT 'CALCULATED' CHECK (status IN ('CALCULATED','APPROVED','REJECTED','OVERRIDDEN')),
    human_reviewer                       UUID REFERENCES users(user_id),
    human_decision                        TEXT CHECK (human_decision IN ('APPROVE','REJECT','OVERRIDE')),
    override_reason                        TEXT,
    computed_by                             TEXT NOT NULL DEFAULT 'SYSTEM',
    computed_at                              TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at                               TIMESTAMPTZ
);
CREATE INDEX idx_cds_candidate ON candidate_dimension_scores(candidate_id, computed_at DESC);
CREATE INDEX idx_cds_org_status ON candidate_dimension_scores(org_id, status);

-- ---------------------------------------------------------------------
-- Seed: two built-in templates with their default 7 dimensions each.
-- These are org_id IS NULL rows — visible to every org as a starting
-- point via Brain Studio / POST /dimensions/configure (clone-and-edit),
-- never scored directly themselves.
-- ---------------------------------------------------------------------

INSERT INTO dimension_templates (template_id, org_id, code, name, description, is_builtin)
VALUES
  ('00000000-0000-0000-0000-000000000101', NULL, 'UROS_CORE_7', 'UROS Core 7',
   'Screening-focused dimension set built directly on normalized candidate/academic data. Best fit for high-volume eligibility-adjacent screening.', true),
  ('00000000-0000-0000-0000-000000000102', NULL, 'INDUSTRY_7', 'Industry 7',
   'Quality-of-hire-focused dimension set aligned to departmental personas. Best fit for corporate/bank role matching beyond pure academics.', true);

-- UROS_CORE_7 default dimensions (org_id NULL = template default)
INSERT INTO dimension_configs (dimension_config_id, org_id, template_id, persona_id, dimension_key, dimension_name, sequence, weight, is_knockout, knockout_threshold)
VALUES
  ('00000000-0000-0000-0000-000000000111', NULL, '00000000-0000-0000-0000-000000000101', NULL, 'EDUCATION',            'Education',                  1, 25, false, NULL),
  ('00000000-0000-0000-0000-000000000112', NULL, '00000000-0000-0000-0000-000000000101', NULL, 'ACADEMIC_PERFORMANCE', 'Academic Performance',       2, 15, false, NULL),
  ('00000000-0000-0000-0000-000000000113', NULL, '00000000-0000-0000-0000-000000000101', NULL, 'EXPERIENCE',           'Experience',                 3, 20, false, NULL),
  ('00000000-0000-0000-0000-000000000114', NULL, '00000000-0000-0000-0000-000000000101', NULL, 'SKILLS',               'Skills',                     4, 15, false, NULL),
  ('00000000-0000-0000-0000-000000000115', NULL, '00000000-0000-0000-0000-000000000101', NULL, 'CERTIFICATIONS',       'Certifications',             5, 10, false, NULL),
  ('00000000-0000-0000-0000-000000000116', NULL, '00000000-0000-0000-0000-000000000101', NULL, 'DOCUMENT_COMPLETENESS','Document Completeness',      6, 10, true,  50),
  ('00000000-0000-0000-0000-000000000117', NULL, '00000000-0000-0000-0000-000000000101', NULL, 'QUOTA_COMPLIANCE',     'Quota / Eligibility Compliance', 7, 5, false, NULL);

-- INDUSTRY_7 default dimensions (org_id NULL = template default)
INSERT INTO dimension_configs (dimension_config_id, org_id, template_id, persona_id, dimension_key, dimension_name, sequence, weight, is_knockout, knockout_threshold)
VALUES
  ('00000000-0000-0000-0000-000000000121', NULL, '00000000-0000-0000-0000-000000000102', NULL, 'ROLE_EXPERIENCE',      'Role-Relevant Experience',   1, 25, false, NULL),
  ('00000000-0000-0000-0000-000000000122', NULL, '00000000-0000-0000-0000-000000000102', NULL, 'TECHNICAL_SKILLS',     'Technical Skill Match',       2, 20, false, NULL),
  ('00000000-0000-0000-0000-000000000123', NULL, '00000000-0000-0000-0000-000000000102', NULL, 'CERTIFICATIONS',       'Certifications & Licenses',   3, 10, false, NULL),
  ('00000000-0000-0000-0000-000000000124', NULL, '00000000-0000-0000-0000-000000000102', NULL, 'SOFT_SKILLS',          'Soft Skills / Behavioral Fit',4, 15, false, NULL),
  ('00000000-0000-0000-0000-000000000125', NULL, '00000000-0000-0000-0000-000000000102', NULL, 'KPI_BASELINE',         'KPI Baseline Alignment',      5, 10, false, NULL),
  ('00000000-0000-0000-0000-000000000126', NULL, '00000000-0000-0000-0000-000000000102', NULL, 'CULTURE_FIT',          'Cultural / Customer Orientation Fit', 6, 10, false, NULL),
  ('00000000-0000-0000-0000-000000000127', NULL, '00000000-0000-0000-0000-000000000102', NULL, 'CAREER_TRAJECTORY',    'Career Trajectory & Stability',8, 10, false, NULL);

-- Illustrative default sub-criteria for UROS_CORE_7 (orgs clone and edit
-- these via Brain Studio / POST /dimensions/configure; nothing here is
-- scored until an org activates its own dimension_configs rows).
INSERT INTO dimension_subcriteria (dimension_config_id, field_path, label, operator, threshold_value, weight, evidence_doc_type, reason_code)
VALUES
  ('00000000-0000-0000-0000-000000000111', 'academic.bachelor.division_class', 'Bachelor Division/Class', 'NOT_IN', '["Third"]', 60, 'Bachelor Certificate', 'THIRD_DIVISION_BACHELOR'),
  ('00000000-0000-0000-0000-000000000111', 'highest_education_level', 'Minimum Education Level', 'IN', '["Bachelor","Masters"]', 40, 'Bachelor Certificate', 'BELOW_MIN_EDUCATION'),
  ('00000000-0000-0000-0000-000000000112', 'academic.bachelor.cgpa', 'Bachelor CGPA', 'GTE', '3.00', 100, 'Bachelor Certificate', 'CGPA_BELOW_MIN'),
  ('00000000-0000-0000-0000-000000000113', 'total_experience_years', 'Total Years of Experience', 'GTE', '2', 100, 'Experience Certificate', 'EXPERIENCE_BELOW_MIN'),
  ('00000000-0000-0000-0000-000000000116', 'documents_verified_ratio', 'Verified Document Ratio', 'GTE', '0.8', 100, NULL, 'DOCUMENTS_INCOMPLETE');
