/**
 * Session lifecycle — Quest 05 Decision Lock 2.
 *
 * Durations (locked): access token 1h, refresh token 7 days, idle timeout
 * 12h, absolute session expiry 30 days, refresh rotates on every use,
 * max 5 concurrent sessions per user.
 *
 * Stated assumption (Decision Lock 2 fixes the cap but not the overflow
 * behaviour): when a 6th session is created, the OLDEST active session is
 * evicted (revoked, audited SESSION_EVICTED) so a legitimate sign-in never
 * fails closed and the cap self-heals. Users see evictions in the session
 * manager; admins see them in the audit trail.
 *
 * Refresh-token reuse detection: a presented token that is already
 * `used_at`-marked (i.e. was rotated away) revokes its entire session —
 * the only realistic explanation for replay of a rotated token is theft.
 */
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { generateToken, hashToken } from "./tokens";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MAX_CONCURRENT_SESSIONS = 5;
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** Throttle for last_used_at writes: at most one UPDATE per session per minute. */
const TOUCH_THROTTLE_MS = 60 * 1000;

export interface ActiveSession {
  session_id: string;
  user_id: string;
  org_id: string;
  created_at: Date;
  last_used_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  ip: string | null;
  user_agent: string | null;
}

/**
 * Creates a session row. Enforces the 5-session cap by evicting the
 * oldest active session first (audited).
 */
export async function createSession(userId: string, orgId: string, ip: string | null, userAgent: string | null): Promise<string> {
  const active = await db.query<{ session_id: string }>(
    `SELECT session_id FROM user_sessions
     WHERE user_id=$1 AND revoked_at IS NULL
       AND absolute_expires_at > now()
       AND last_used_at > now() - interval '12 hours'
     ORDER BY created_at ASC`,
    [userId]
  );
  if (active.rows.length >= MAX_CONCURRENT_SESSIONS) {
    const evicted = active.rows[0].session_id;
    await revokeSession(evicted, userId, "SESSION_LIMIT_EVICTED");
    await logAudit({
      org_id: orgId,
      entity_type: "USER",
      entity_id: userId,
      agent_or_user: userId,
      action: "SESSION_EVICTED",
      reason_code: "SESSION_LIMIT",
      reason_comment: `Oldest of ${active.rows.length} active sessions evicted at sign-in (max ${MAX_CONCURRENT_SESSIONS}).`,
      output_value: { evicted_session_id: evicted },
    });
  }

  const inserted = await db.query<{ session_id: string }>(
    `INSERT INTO user_sessions (user_id, org_id, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5)
     RETURNING session_id`,
    [userId, orgId, SESSION_ABSOLUTE_TTL_MS / 1000, ip, userAgent]
  );
  return inserted.rows[0].session_id;
}

/** Issues (and stores only the hash of) a fresh refresh token for a session. */
export async function issueRefreshToken(sessionId: string, userId: string): Promise<string> {
  const raw = generateToken();
  await db.query(
    `INSERT INTO auth_refresh_tokens (session_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [sessionId, userId, hashToken(raw), REFRESH_TOKEN_TTL_MS / 1000]
  );
  return raw;
}

export interface RotatedRefresh {
  session_id: string;
  user_id: string;
  raw: string;
}

/**
 * Consumes a presented refresh token and issues its replacement.
 * Throws RefreshTokenError (with .code) on any invalid state — the route
 * maps every code to the same "sign in again" outcome plus cookie clear.
 */
export class RefreshTokenError extends Error {
  code: "INVALID" | "EXPIRED" | "REUSED";
  constructor(code: RefreshTokenError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "RefreshTokenError";
  }
}

export async function rotateRefreshToken(rawToken: string): Promise<RotatedRefresh> {
  const presentedHash = hashToken(rawToken);

  const existing = await db.query<{
    token_id: string;
    session_id: string;
    user_id: string;
    used_at: Date | null;
    revoked_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT token_id, session_id, user_id, used_at, revoked_at, expires_at
     FROM auth_refresh_tokens WHERE token_hash=$1`,
    [presentedHash]
  );
  const token = existing.rows[0];
  if (!token) throw new RefreshTokenError("INVALID", "Unknown refresh token.");
  if (token.revoked_at) throw new RefreshTokenError("INVALID", "Refresh token revoked.");
  if (token.expires_at.getTime() <= Date.now()) throw new RefreshTokenError("EXPIRED", "Refresh token expired.");

  if (token.used_at) {
    // Reuse of an already-rotated token: assume theft, kill the session.
    await db.query(`UPDATE user_sessions SET revoked_at=now(), revoke_reason='REFRESH_TOKEN_REUSE' WHERE session_id=$1`, [token.session_id]);
    await db.query(`UPDATE auth_refresh_tokens SET revoked_at=now() WHERE session_id=$1 AND revoked_at IS NULL`, [token.session_id]);
    const sess = await db.query<{ user_id: string; org_id: string }>(`SELECT user_id, org_id FROM user_sessions WHERE session_id=$1`, [token.session_id]);
    if (sess.rows[0]) {
      await logAudit({
        org_id: sess.rows[0].org_id,
        entity_type: "USER",
        entity_id: sess.rows[0].user_id,
        agent_or_user: sess.rows[0].user_id,
        action: "REFRESH_TOKEN_REUSE",
        reason_code: "TOKEN_REUSED",
        reason_comment: "A rotated refresh token was replayed; the whole session was revoked as a theft response.",
        output_value: { session_id: token.session_id },
      });
    }
    throw new RefreshTokenError("REUSED", "Refresh token was already used; session revoked.");
  }

  const raw = generateToken();
  await db.query(
    `INSERT INTO auth_refresh_tokens (session_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [token.session_id, token.user_id, hashToken(raw), REFRESH_TOKEN_TTL_MS / 1000]
  );
  const child = await db.query<{ token_id: string }>(`SELECT token_id FROM auth_refresh_tokens WHERE token_hash=$1`, [hashToken(raw)]);
  await db.query(
    `UPDATE auth_refresh_tokens SET used_at=now(), replaced_by=$2 WHERE token_id=$1`,
    [token.token_id, child.rows[0].token_id]
  );
  return { session_id: token.session_id, user_id: token.user_id, raw };
}

/** Validates a session for an inbound authenticated request. Returns null when the session is dead. */
export async function validateSession(sessionId: string): Promise<ActiveSession | null> {
  // revoked_at MUST be selected — it is the liveness signal the middleware
  // relies on after every logout / eviction / theft response.
  const res = await db.query<ActiveSession>(
    `SELECT session_id, user_id, org_id, created_at, last_used_at, absolute_expires_at, revoked_at, ip, user_agent
     FROM user_sessions WHERE session_id=$1`,
    [sessionId]
  );
  const s = res.rows[0];
  if (!s) return null;
  if (s.revoked_at) return null;
  if (s.absolute_expires_at.getTime() <= Date.now()) return null;
  if (Date.now() - s.last_used_at.getTime() > SESSION_IDLE_TIMEOUT_MS) return null;
  return s;
}

/** Marks activity. Throttled: skips the write when the last touch is younger than one minute. */
export async function touchSession(sessionId: string): Promise<void> {
  await db.query(
    `UPDATE user_sessions SET last_used_at=now()
     WHERE session_id=$1 AND last_used_at < now() - make_interval(secs => $2)`,
    [sessionId, TOUCH_THROTTLE_MS / 1000]
  );
}

/** Revokes one session and all of its refresh tokens. */
export async function revokeSession(sessionId: string, revokedBy: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE user_sessions SET revoked_at=now(), revoked_by=$2, revoke_reason=$3
     WHERE session_id=$1 AND revoked_at IS NULL`,
    [sessionId, revokedBy, reason]
  );
  await db.query(`UPDATE auth_refresh_tokens SET revoked_at=now() WHERE session_id=$1 AND revoked_at IS NULL`, [sessionId]);
}

/** Revokes every active session for a user (logout-all, password change/reset, admin action). */
export async function revokeAllSessionsForUser(userId: string, revokedBy: string, reason: string, exceptSessionId?: string): Promise<number> {
  const res = await db.query<{ session_id: string }>(
    `UPDATE user_sessions SET revoked_at=now(), revoked_by=$2, revoke_reason=$3
     WHERE user_id=$1 AND revoked_at IS NULL AND ($4::uuid IS NULL OR session_id <> $4)
     RETURNING session_id`,
    [userId, revokedBy, reason, exceptSessionId ?? null]
  );
  const ids = res.rows.map((r) => r.session_id);
  if (ids.length > 0) {
    await db.query(`UPDATE auth_refresh_tokens SET revoked_at=now() WHERE session_id = ANY($1::uuid[]) AND revoked_at IS NULL`, [ids]);
  }
  return ids.length;
}

/** Active = not revoked, inside absolute window, inside idle window. */
export async function listActiveSessions(userId: string): Promise<Array<ActiveSession & { current: boolean }>> {
  const res = await db.query<ActiveSession>(
    `SELECT session_id, user_id, org_id, created_at, last_used_at, absolute_expires_at, ip, user_agent
     FROM user_sessions
     WHERE user_id=$1 AND revoked_at IS NULL
       AND absolute_expires_at > now()
       AND last_used_at > now() - interval '12 hours'
     ORDER BY last_used_at DESC`,
    [userId]
  );
  return res.rows.map((r) => ({ ...r, current: false }));
}
