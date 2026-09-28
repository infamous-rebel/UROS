-- 0019_multilang.sql
-- Feature 5: Multi-Language Interface and Document Support (English / Bangla)
--
-- Data itself remains language-neutral (per UROS_Global_Reasoning_Standard.md
-- and UROS_Product_Roadmap: "data remains language-neutral; only
-- presentation layer and templates change"). These columns only ever
-- affect *which language variant of UI copy / communication template*
-- is selected — never eligibility, scoring, or any other decision logic.

-- Organisation-level default language: used as the fallback when a user
-- or candidate has not set a personal preference.
ALTER TABLE organizations
    ADD COLUMN default_language TEXT NOT NULL DEFAULT 'en'
        CHECK (default_language IN ('en', 'bn'));

-- Staff user-level override (dashboard UI language). NULL = no personal
-- override; falls back to organizations.default_language.
ALTER TABLE users
    ADD COLUMN preferred_language TEXT
        CHECK (preferred_language IN ('en', 'bn'));

-- Candidate-level preference, required to deterministically select a
-- communication template language variant per
-- UROS_Product_Roadmap_Feature_Expansion_Updated.md Feature 5: "Choose
-- template by candidate preferred_language or org default." NULL = no
-- preference recorded; falls back to organizations.default_language.
ALTER TABLE candidates
    ADD COLUMN preferred_language TEXT
        CHECK (preferred_language IN ('en', 'bn'));

-- Records which language variant was actually sent for a given message,
-- so the audit trail shows the real outcome of template resolution
-- (Global Reasoning Standard: every outcome carries evidence of what
-- was produced, not just what was requested).
ALTER TABLE communication_log
    ADD COLUMN language TEXT
        CHECK (language IN ('en', 'bn'));
