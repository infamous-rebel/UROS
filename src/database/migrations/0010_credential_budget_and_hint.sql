-- 0010_credential_budget_and_hint.sql
-- Supports the BYOK Credential API (masked-key listing, per-connector
-- budget caps for rate/cost control per the BYOK requirement doc).
ALTER TABLE api_credentials
    ADD COLUMN budget_cap  NUMERIC,
    ADD COLUMN budget_used NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN key_hint    TEXT; -- masked at write time, e.g. "sk-1***9f2a"; never the real key
