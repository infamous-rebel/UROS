-- 0035_org_membership_prefs.sql
-- Quest 05 Part 2 — Full CommandBar: org switcher.
--
-- The spec requires a dropdown of "all orgs the user belongs to" with the
-- choice persisted as a user preference. The 0001 schema hard-wired one org
-- per account (users.org_id NOT NULL), so membership is modeled explicitly:
--
--   user_org_memberships  — the orgs a user may operate in (seeded from the
--                           existing users.org_id rows so every current
--                           account keeps exactly its home org);
--   users.preferred_org_id — the persisted preference; login and org switch
--                           resolve the ACTIVE org to it (falling back to
--                           users.org_id when the preference is unset or
--                           points at a non-member org).
--
-- users.org_id stays the immutable home org: no existing query, seed, or
-- test changes meaning. Tenant isolation continues to flow from the JWT's
-- org claim, which the auth service now mints from the resolved active org.

-- 1. Membership table.
CREATE TABLE IF NOT EXISTS user_org_memberships (
    user_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    org_id   UUID NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    role     TEXT NOT NULL CHECK (role IN
             ('ADMIN','RECRUITER','SENIOR_RECRUITER','AUDITOR',
              'DEPT_HEAD','APPLICANT','SYSTEM_AGENT')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_user_org_memberships_org ON user_org_memberships(org_id);

-- Backfill: every existing account is a member of its home org, carrying
-- its own role. Idempotent — re-runs add nothing new.
INSERT INTO user_org_memberships (user_id, org_id, role)
SELECT user_id, org_id, role FROM users
ON CONFLICT (user_id, org_id) DO NOTHING;

-- 2. Persisted org preference.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_org_id UUID REFERENCES organizations(org_id);

-- Backfill: the preference starts at the home org. NULL is allowed on the
-- column (it means "unset") but existing rows get an explicit value so the
-- resolution path in the auth service never has to guess for current data.
UPDATE users SET preferred_org_id = org_id WHERE preferred_org_id IS NULL;
