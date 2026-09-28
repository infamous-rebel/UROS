-- 0023_indexes.sql
-- Security Hardening Round: confirmed-missing FK indexes on tables now
-- queried by joins added in this round (rules/appeals org-scoping) plus
-- other high-traffic FK columns found unindexed during the audit.
-- Verified NOT already present before adding (evaluation_results and
-- fraud_flags candidate_id/rule_id/check_id indexes already existed
-- from earlier migrations and are intentionally not duplicated here;
-- reference_requests table does not exist in this codebase and is
-- skipped).

CREATE INDEX idx_rule_pack_versions_pack ON rule_pack_versions(rule_pack_id);
CREATE INDEX idx_rule_packs_org ON rule_packs(org_id);
CREATE INDEX idx_appeals_candidate ON appeals(candidate_id);
CREATE INDEX idx_candidate_experience_candidate ON candidate_experience(candidate_id);
CREATE INDEX idx_verification_results_candidate ON verification_results(candidate_id);
CREATE INDEX idx_communication_log_candidate ON communication_log(candidate_id);
