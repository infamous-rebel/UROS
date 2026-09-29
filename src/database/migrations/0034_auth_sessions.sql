-- 0034_auth_sessions.sql
-- Quest 05 Part 1 — Authentication & Session
--
-- NOTE ON NUMBERING: the Quest 05 spec calls this "Migration 0033", but
-- 0033 was consumed by Quest 04 (import_batches). This is the same schema,
-- renumbered to the next free sequence slot.
--
-- 1. users: password + contact columns (phone added for SMS-first reset
--    delivery per Decision Lock 1).
-- 2. user_sessions: durable session rows (idle timeout 12h via last_used_at,
--    absolute expiry 30d, revocation trail with reason). Max 5 concurrent
--    sessions per user is enforced in code (oldest evicted, audited).
-- 3. auth_refresh_tokens: rotating refresh tokens — SHA-256 hashes only,
--    never raw tokens. Rotation invalidates the used token and links the
--    child (replaced_by) so reuse of an old token is detectable.
-- 4. password_reset_tokens: single-use reset links, 30-minute expiry.
--    Lifecycle logged: issued_at → clicked_at → consumed_at (Decision
--    Lock 1: every reset link is logged issued, clicked, consumed).

-- 1. users columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every pre-existing account without a password hash is exactly
-- an account that must complete the set-password flow — flag it, or it
-- would be permanently signed-in-less with no reachable reset path.
UPDATE users SET password_reset_required = true WHERE password_hash IS NULL;

-- 1b. communication_log.candidate_id becomes nullable: user-directed auth
--     messages (password reset links, invites) dispatch through the same
--     dispatcher path and communication_log tracking, but are not
--     candidate-scoped — candidate_id is NULL on those rows.
ALTER TABLE communication_log ALTER COLUMN candidate_id DROP NOT NULL;

-- 2. user_sessions
CREATE TABLE IF NOT EXISTS user_sessions (
    session_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    org_id               UUID NOT NULL REFERENCES organizations(org_id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    absolute_expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at           TIMESTAMPTZ,
    revoked_by           UUID REFERENCES users(user_id),
    revoke_reason        TEXT,
    ip                   TEXT,
    user_agent           TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
    ON user_sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_org
    ON user_sessions(org_id);

-- 3. auth_refresh_tokens
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
    token_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID NOT NULL REFERENCES user_sessions(session_id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    replaced_by  UUID REFERENCES auth_refresh_tokens(token_id),
    revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_session
    ON auth_refresh_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_user
    ON auth_refresh_tokens(user_id);

-- 4. password_reset_tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    issued_by    UUID REFERENCES users(user_id),
    issued_via   TEXT NOT NULL DEFAULT 'SELF'
                 CHECK (issued_via IN ('SELF', 'ADMIN_HANDOFF')),
    channel      TEXT NOT NULL DEFAULT 'SMS'
                 CHECK (channel IN ('SMS', 'EMAIL', 'IN_PERSON')),
    clicked_at   TIMESTAMPTZ,
    consumed_at  TIMESTAMPTZ,
    ip           TEXT,
    user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
    ON password_reset_tokens(user_id);
