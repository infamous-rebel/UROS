-- 0030_tenant_isolation.sql
-- Quest 02: Every tenant-scoped table carries org_id. Every query that
-- reads or writes tenant-scoped data filters by org_id. Cross-tenant
-- leakage becomes structurally impossible.
--
-- Tables fixed: audit_log, evaluation_results, scoring_results,
-- verification_results, communication_log, appeals.
-- gate_events already has org_id (migration 0022). Confirmed.
--
-- Sequence: expand → backfill → contract (NOT NULL + FK + indexes).
-- Idempotent: IF NOT EXISTS / IF EXISTS throughout.

-- =====================================================================
-- 1. EXPAND — add nullable org_id to each table
-- =====================================================================

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS scope VARCHAR(10) NOT NULL DEFAULT 'TENANT';
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE scoring_results ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE verification_results ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE communication_log ADD COLUMN IF NOT EXISTS org_id UUID;
ALTER TABLE appeals ADD COLUMN IF NOT EXISTS org_id UUID;

-- =====================================================================
-- 2. BACKFILL — derive org_id from candidates (all six tables relate
--    to candidates, either directly via candidate_id or indirectly).
-- =====================================================================

-- evaluation_results: direct join to candidates
UPDATE evaluation_results er
SET org_id = c.org_id
FROM candidates c
WHERE c.candidate_id = er.candidate_id
  AND er.org_id IS NULL;

-- scoring_results: direct join to candidates
UPDATE scoring_results sr
SET org_id = c.org_id
FROM candidates c
WHERE c.candidate_id = sr.candidate_id
  AND sr.org_id IS NULL;

-- verification_results: direct join to candidates
UPDATE verification_results vr
SET org_id = c.org_id
FROM candidates c
WHERE c.candidate_id = vr.candidate_id
  AND vr.org_id IS NULL;

-- communication_log: direct join to candidates
UPDATE communication_log cl
SET org_id = c.org_id
FROM candidates c
WHERE c.candidate_id = cl.candidate_id
  AND cl.org_id IS NULL;

-- appeals: direct join to candidates
UPDATE appeals a
SET org_id = c.org_id
FROM candidates c
WHERE c.candidate_id = a.candidate_id
  AND a.org_id IS NULL;

-- audit_log: multi-path backfill.
-- Path A: entity_id matches a candidate_id directly (CANDIDATE, EVALUATION,
--   ELIGIBILITY_RECOMMENDATION, VERIFICATION, FRAUD_CHECK, APPEAL,
--   DIMENSION_SCORE, REDISCOVERY_CONSENT, REDISCOVERY_SUGGESTION,
--   APPLICANT_PORTAL, DIGITAL_EXAM_SUBMISSION, OVERRIDE, COMMUNICATION).
-- Path B: entity_id matches an evaluation_jobs.job_id (EVALUATION_JOB,
--   EVALUATION_PIPELINE).
-- Path C: entity_id matches a candidate_dimension_scores.evaluation_id
--   (DIMENSION_SCORE, DIMENSION_RUN).
-- Remaining rows (BATCH, PIPELINE_STAGE, AGENT_BATCH, REPORT, etc.) have
-- entity_ids that are batch-keys or circular-names without a deterministic
-- org mapping — these get scope='SYSTEM' and org_id stays NULL.

UPDATE audit_log al
SET org_id = COALESCE(
  (SELECT c.org_id FROM candidates c WHERE c.candidate_id = al.entity_id LIMIT 1),
  (SELECT ej.org_id FROM evaluation_jobs ej WHERE ej.job_id::text = al.entity_id LIMIT 1),
  (SELECT cds.org_id FROM candidate_dimension_scores cds WHERE cds.evaluation_id::text = al.entity_id LIMIT 1)
)
WHERE al.org_id IS NULL;

-- Mark rows that could not be backfilled as SYSTEM scope.
-- Rows with org_id still NULL after backfill are infrastructure-level
-- entries (SUPERVISOR, PROCESS, AGENT, AGENT_BATCH, etc.) that genuinely
-- lack org context.
UPDATE audit_log
SET scope = 'SYSTEM'
WHERE org_id IS NULL;

-- =====================================================================
-- 3. CONTRACT — NOT NULL where backfill is complete, FK, indexes
-- =====================================================================

-- evaluation_results, scoring_results, verification_results,
-- communication_log, appeals: all rows should now have org_id (every row
-- references a candidate). Set NOT NULL.
ALTER TABLE evaluation_results ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE scoring_results ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE verification_results ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE communication_log ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE appeals ALTER COLUMN org_id SET NOT NULL;

-- audit_log: rows with scope='TENANT' MUST have org_id (enforced by CHECK).
-- Rows with scope='SYSTEM' (infrastructure-level: SUPERVISOR, PROCESS,
-- AGENT circuit breaker, AGENT_BATCH) may have NULL org_id.
-- Partial index on (org_id, timestamp) WHERE org_id IS NOT NULL for
-- efficient tenant-scoped queries.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_audit_tenant_has_org') THEN
    ALTER TABLE audit_log ADD CONSTRAINT chk_audit_tenant_has_org
      CHECK (scope != 'TENANT' OR org_id IS NOT NULL);
  END IF;
END $$;

-- Foreign keys
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_audit_log_org') THEN
    ALTER TABLE audit_log ADD CONSTRAINT fk_audit_log_org
      FOREIGN KEY (org_id) REFERENCES organizations(org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_evaluation_results_org') THEN
    ALTER TABLE evaluation_results ADD CONSTRAINT fk_evaluation_results_org
      FOREIGN KEY (org_id) REFERENCES organizations(org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_scoring_results_org') THEN
    ALTER TABLE scoring_results ADD CONSTRAINT fk_scoring_results_org
      FOREIGN KEY (org_id) REFERENCES organizations(org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_verification_results_org') THEN
    ALTER TABLE verification_results ADD CONSTRAINT fk_verification_results_org
      FOREIGN KEY (org_id) REFERENCES organizations(org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_communication_log_org') THEN
    ALTER TABLE communication_log ADD CONSTRAINT fk_communication_log_org
      FOREIGN KEY (org_id) REFERENCES organizations(org_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_appeals_org') THEN
    ALTER TABLE appeals ADD CONSTRAINT fk_appeals_org
      FOREIGN KEY (org_id) REFERENCES organizations(org_id);
  END IF;
END $$;

-- =====================================================================
-- 4. INDEXES
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_audit_log_org_time
  ON audit_log (org_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_eval_results_org_candidate
  ON evaluation_results (org_id, candidate_id);

CREATE INDEX IF NOT EXISTS idx_eval_results_org_status
  ON evaluation_results (org_id, status);

CREATE INDEX IF NOT EXISTS idx_scoring_results_org_candidate
  ON scoring_results (org_id, candidate_id);

CREATE INDEX IF NOT EXISTS idx_verification_results_org_candidate
  ON verification_results (org_id, candidate_id);

CREATE INDEX IF NOT EXISTS idx_verification_results_org_source_status
  ON verification_results (org_id, source, status);

CREATE INDEX IF NOT EXISTS idx_communication_log_org_candidate
  ON communication_log (org_id, candidate_id);

CREATE INDEX IF NOT EXISTS idx_communication_log_org_sent
  ON communication_log (org_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_appeals_org_status
  ON appeals (org_id, status);

CREATE INDEX IF NOT EXISTS idx_appeals_org_candidate
  ON appeals (org_id, candidate_id);

-- Partial index for audit_log: efficient org-scoped queries even though
-- org_id is nullable (non-candidate entity types).
CREATE INDEX IF NOT EXISTS idx_audit_log_org_not_null
  ON audit_log (org_id, timestamp DESC) WHERE org_id IS NOT NULL;
