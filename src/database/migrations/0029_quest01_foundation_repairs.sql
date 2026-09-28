-- 0029_quest01_foundation_repairs.sql
-- Quest 01: Foundation Repair (Runtime Blockers)
--
-- 1. Widen api_credentials.connector CHECK to include 'llm' (Groq-ready).
-- 2. Add unique index on scoring_results(candidate_id, rule_pack_version_id)
--    for ON CONFLICT upsert in stageScoringAndRanking.

-- 1. Drop old CHECK constraint and recreate with 'llm' included.
ALTER TABLE api_credentials DROP CONSTRAINT IF EXISTS api_credentials_connector_check;
ALTER TABLE api_credentials ADD CONSTRAINT api_credentials_connector_check
    CHECK (connector IN (
        'teletalk','bdjobs','linkedin','email','sms_provider',
        'whatsapp_business','calendar','education_board','cib','police','llm'
    ));

-- 2. Unique index for scoring upsert (idempotent via IF NOT EXISTS).
CREATE UNIQUE INDEX IF NOT EXISTS uq_scoring_candidate_rule_pack
    ON scoring_results(candidate_id, rule_pack_version_id);
