-- 0022_gate_org_id.sql
-- Security Hardening Round: gate_events had no org_id at all, so
-- POST /api/v1/gates/:gateId/resolve could approve/reject/override any
-- org's pending HIL gate given only a guessable UUID. Adds org_id so
-- resolution can be scoped to the caller's org (see hil_gates.ts
-- createGate/resolveGate, threaded from pipeline.ts and consumer.ts).
--
-- Nullable: existing PENDING gate rows created before this migration
-- (if any) have no reliable way to derive their org from batch_id alone
-- and cannot be resolved via the API until backfilled by an operator
-- with direct database access — resolveGate() fails closed (404) for a
-- gate whose org_id is NULL or does not match the caller's org, which
-- is the correct fail-safe behavior for a forward-only migration that
-- cannot know the org of pre-existing rows.
ALTER TABLE gate_events ADD COLUMN org_id UUID REFERENCES organizations(org_id);
CREATE INDEX idx_gate_events_org ON gate_events(org_id, status);
