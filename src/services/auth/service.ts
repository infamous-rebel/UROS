/**
 * Authentication service — Quest 05 Part 1.
 *
 * Implements Decision Lock 1 (login credential policy) and Decision Lock 2
 * (session durations) on top of `sessions.ts` / `password.ts` / `tokens.ts`.
 *
 * Delivery of password-reset links is SMS-first with email fallback
 * (Decision Lock 1). Links ride the same dispatcher path as candidate
 * communication — the PASSWORD_RESET_LINK template renders into the
 * message and every delivery attempt lands in communication_log with
 * provider tracking — but with `candidate_id` NULL because these are
 * user-directed, infrastructure messages. There is no reset link without
 * a dispatcher outcome: delivery failures are audited
 * (PASSWORD_RESET_LINK_FAILED) and the request endpoint still answers
 * with the generic anti-enumeration response; in-person admin handoff is
 * always available as the last resort.
 *
 * Anti-enumeration: request-password-reset responds identically whether
 * or not the email exists; login timing is evened out by always running
 * the bcrypt comparison (dummy hash when the account has no password).
 */
import jwt from "jsonwebtoken";
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logAudit } from "../../utils/audit_helper";
import { logger } from "../../utils/logger";
import { SupportedLanguage } from "../../models/organization.model";
import { dispatchMessage } from "../communication/dispatcher";
import { renderTemplateBody } from "../communication/template_bodies";
import { hashPassword, verifyPassword, passwordPolicyError } from "./password";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  RESET_TOKEN_TTL_MS,
  createSession,
  issueRefreshToken,
  revokeAllSessionsForUser,
  revokeSession,
  rotateRefreshToken,
  RefreshTokenError,
  type RotatedRefresh,
} from "./sessions";
import { generateToken, hashToken } from "./tokens";
import type { UserRole } from "../../models/user.model";

export class AuthError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.name = "AuthError";
  }
}

export interface AuthenticatedUserInfo {
  user_id: string;
  org_id: string;
  role: UserRole;
  full_name: string;
  email: string | null;
  preferred_language: SupportedLanguage | null;
  password_reset_required: boolean;
}

export interface LoginSuccess {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  user: AuthenticatedUserInfo;
}

interface UserRow extends AuthenticatedUserInfo {
  active: boolean;
  password_hash: string | null;
  phone: string | null;
  /** Persisted org preference (Quest 05 Part 2 org switcher). */
  preferred_org_id: string | null;
}

function accessTokenFor(user: { user_id: string; org_id: string; role: string }, sessionId: string): string {
  return jwt.sign({ user_id: user.user_id, org_id: user.org_id, role: user.role, session_id: sessionId }, env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

function userRowToInfo(row: UserRow): AuthenticatedUserInfo {
  return {
    user_id: row.user_id,
    org_id: row.org_id,
    role: row.role,
    full_name: row.full_name,
    email: row.email,
    preferred_language: row.preferred_language,
    password_reset_required: row.password_reset_required,
  };
}

const USER_COLUMNS = "user_id, org_id, role, full_name, email, preferred_language, password_reset_required, active, password_hash, phone, preferred_org_id";

async function loadUserByEmail(email: string): Promise<UserRow | null> {
  const res = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email)=lower($1)`,
    [email]
  );
  return res.rows[0] ?? null;
}

async function loadUserById(userId: string): Promise<UserRow | null> {
  const res = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE user_id=$1`,
    [userId]
  );
  return res.rows[0] ?? null;
}

/**
 * The org the person is currently operating in: their persisted preference
 * when they are still a member of it, else their home org (Quest 05 Part 2).
 * Tenant isolation rides on this value via the JWT org claim, so a stale
 * preference pointing at a non-member org must never resolve.
 */
async function resolveActiveOrg(user: UserRow): Promise<string> {
  if (user.preferred_org_id) {
    const member = await db.query(
      `SELECT 1 FROM user_org_memberships WHERE user_id=$1 AND org_id=$2`,
      [user.user_id, user.preferred_org_id]
    );
    if (member.rows.length > 0) return user.preferred_org_id;
  }
  return user.org_id;
}

/** POST /auth/login */
export async function login(email: string, password: string, ip: string | null, userAgent: string | null): Promise<LoginSuccess> {
  const user = await loadUserByEmail(email);
  // Always run the comparison — dummy hash evens out timing and keeps
  // "unknown email" and "wrong password" indistinguishable.
  const passwordOk = await verifyPassword(password, user?.password_hash ?? null);

  if (!user || !user.active) {
    await logAudit({
      org_id: user?.org_id,
      entity_type: "USER",
      entity_id: user?.user_id ?? email,
      agent_or_user: user?.user_id ?? email,
      action: "USER_LOGIN_FAILED",
      reason_code: "UNKNOWN_OR_INACTIVE_ACCOUNT",
      reason_comment: "Login failed.",
      input_value: { ip, user_agent: userAgent },
    });
    throw new AuthError("INVALID_CREDENTIALS", 401, "Email or password is incorrect.");
  }

  if (user.password_reset_required) {
    // Decision Lock 1: no temp passwords, no admin bypass. Sign-in is
    // blocked while the flag is set — regardless of the password offered,
    // and for invited (passwordless) accounts too — so the response is one
    // actionable instruction: complete the set-password flow (SMS/email
    // link or in-person handoff). Only the reset/confirm flow clears it.
    await logAudit({
      org_id: user.org_id,
      entity_type: "USER",
      entity_id: user.user_id,
      agent_or_user: user.user_id,
      action: "USER_LOGIN_FAILED",
      reason_code: "PASSWORD_RESET_REQUIRED",
      reason_comment: "Sign-in blocked: account must complete the set-password flow first.",
      input_value: { ip, user_agent: userAgent },
    });
    throw new AuthError("PASSWORD_RESET_REQUIRED", 403, "A password must be set before signing in. Use the reset link sent to you or ask an administrator for a new one.");
  }

  if (!passwordOk) {
    await logAudit({
      org_id: user.org_id,
      entity_type: "USER",
      entity_id: user.user_id,
      agent_or_user: user.user_id,
      action: "USER_LOGIN_FAILED",
      reason_code: "BAD_CREDENTIALS",
      reason_comment: "Login failed.",
      input_value: { ip, user_agent: userAgent },
    });
    throw new AuthError("INVALID_CREDENTIALS", 401, "Email or password is incorrect.");
  }

  const activeOrgId = await resolveActiveOrg(user);
  const sessionId = await createSession(user.user_id, activeOrgId, ip, userAgent);
  const refreshToken = await issueRefreshToken(sessionId, user.user_id);
  const access_token = accessTokenFor({ ...user, org_id: activeOrgId }, sessionId);

  await logAudit({
    org_id: activeOrgId,
    entity_type: "USER",
    entity_id: user.user_id,
    agent_or_user: user.user_id,
    action: "USER_LOGIN_SUCCESS",
    reason_code: "LOGIN",
    reason_comment: "Signed in with email and password.",
    input_value: { ip, user_agent: userAgent },
    output_value: { session_id: sessionId },
  });

  // Update last_login_at on every successful sign-in
  await db.query(`UPDATE users SET last_login_at = now() WHERE user_id = $1`, [user.user_id]);

  return { access_token, expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, user: { ...userRowToInfo(user), org_id: activeOrgId } };
}

/** GET /auth/me — the signed-in person's own profile (sanitized). */
export async function getCurrentUser(userId: string, activeOrgId?: string): Promise<AuthenticatedUserInfo | null> {
  const user = await loadUserById(userId);
  if (!user || !user.active) return null;
  const info = userRowToInfo(user);
  // The token's org claim is the authoritative active org — it reflects a
  // switch that happened after this row was read from disk.
  return activeOrgId ? { ...info, org_id: activeOrgId } : info;
}

/** GET /auth/orgs — every org the person belongs to, with the active one flagged. */
export async function listUserOrgs(userId: string, activeOrgId?: string): Promise<Array<{ org_id: string; name: string; role: UserRole; active: boolean }>> {
  const res = await db.query<{ org_id: string; name: string; role: UserRole }>(
    `SELECT m.org_id, o.name, m.role
     FROM user_org_memberships m
     JOIN organizations o ON o.org_id = m.org_id
     WHERE m.user_id = $1
     ORDER BY (m.org_id = $2) DESC, o.name ASC`,
    [userId, activeOrgId ?? "00000000-0000-0000-0000-000000000000"]
  );
  return res.rows.map((r) => ({ ...r, active: r.org_id === activeOrgId }));
}

/**
 * POST /auth/orgs/:orgId/switch — Quest 05 Part 2 "switch reloads session".
 * Validates membership, persists the preference, and re-establishes the
 * session in the new org: the old session is revoked (its refresh chain
 * dies with it) and a fresh session + tokens are minted with the new org
 * claim, so nothing cross-org survives in the old context.
 */
export async function switchOrg(
  userId: string,
  newOrgId: string,
  currentSessionId: string | undefined,
  ip: string | null,
  userAgent: string | null
): Promise<LoginSuccess> {
  const user = await loadUserById(userId);
  if (!user || !user.active) throw new AuthError("SWITCH_INVALID", 401, "Your session has ended. Please sign in again.");

  const membership = await db.query(
    `SELECT 1 FROM user_org_memberships WHERE user_id=$1 AND org_id=$2`,
    [userId, newOrgId]
  );
  if (membership.rows.length === 0) {
    throw new AuthError("ORG_NOT_A_MEMBER", 403, "You do not have access to that organization.");
  }

  await db.query(`UPDATE users SET preferred_org_id=$2 WHERE user_id=$1`, [userId, newOrgId]);

  if (currentSessionId) {
    await revokeSession(currentSessionId, userId, "ORG_SWITCH");
  }
  const sessionId = await createSession(userId, newOrgId, ip, userAgent);
  const refreshToken = await issueRefreshToken(sessionId, userId);
  const access_token = accessTokenFor({ ...user, org_id: newOrgId }, sessionId);

  await logAudit({
    org_id: newOrgId,
    entity_type: "USER",
    entity_id: userId,
    agent_or_user: userId,
    action: "ORG_SWITCHED",
    reason_code: "ORG_SWITCH",
    reason_comment: "Switched the active organization; the previous session was revoked.",
    input_value: { ip, user_agent: userAgent, from_org: user.org_id },
    output_value: { session_id: sessionId, org_id: newOrgId },
  });

  return {
    access_token,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    user: { ...userRowToInfo(user), org_id: newOrgId },
  };
}

/** POST /auth/refresh — rotates the refresh token, returns a new access token. */
export async function refreshAccess(rawRefreshToken: string): Promise<{ access_token: string; expires_in: number; refresh_token: string; user: AuthenticatedUserInfo }> {
  let rotated: RotatedRefresh;
  try {
    rotated = await rotateRefreshToken(rawRefreshToken);
  } catch (err) {
    if (err instanceof RefreshTokenError) {
      throw new AuthError(`REFRESH_${err.code}`, 401, "Your session has ended. Please sign in again.");
    }
    throw err;
  }

  const user = await loadUserById(rotated.user_id);
  if (!user || !user.active) throw new AuthError("REFRESH_INVALID", 401, "Your session has ended. Please sign in again.");

  // The session row carries the active org — it was written at login or
  // org-switch time and must win over the user's home org, or a refresh
  // after an org switch would silently drop the person back into the old org.
  const sess = await db.query<{ org_id: string }>(`SELECT org_id FROM user_sessions WHERE session_id=$1`, [rotated.session_id]);
  const activeOrgId = sess.rows[0]?.org_id ?? user.org_id;

  const access_token = accessTokenFor({ ...user, org_id: activeOrgId }, rotated.session_id);
  return { access_token, expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: rotated.raw, user: { ...userRowToInfo(user), org_id: activeOrgId } };
}

/** POST /auth/logout — revokes the current session (and its refresh tokens). */
export async function logout(userId: string, sessionId: string, orgId: string): Promise<void> {
  // Logout ends THIS session only — other devices stay signed in.
  await revokeSession(sessionId, userId, "LOGOUT");
  await logAudit({
    org_id: orgId,
    entity_type: "USER",
    entity_id: userId,
    agent_or_user: userId,
    action: "USER_LOGOUT",
    reason_code: "LOGOUT",
    reason_comment: "Signed out; session revoked.",
    output_value: { session_id: sessionId },
  });
}

/** POST /auth/logout-all — revokes every session for the current user. */
export async function logoutAll(userId: string, orgId: string): Promise<number> {
  const revoked = await revokeAllSessionsForUser(userId, userId, "LOGOUT_ALL");
  await logAudit({
    org_id: orgId,
    entity_type: "USER",
    entity_id: userId,
    agent_or_user: userId,
    action: "USER_LOGOUT_ALL",
    reason_code: "LOGOUT_ALL",
    reason_comment: `Signed out of all devices; ${revoked} session(s) revoked.`,
    output_value: { revoked },
  });
  return revoked;
}

/** POST /auth/password/change */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ip: string | null,
  userAgent: string | null,
  currentSessionId: string
): Promise<void> {
  const user = await loadUserById(userId);
  if (!user || !user.active) throw new AuthError("USER_NOT_FOUND", 404, "Account not found.");

  const currentOk = await verifyPassword(currentPassword, user.password_hash);
  if (!currentOk) {
    await logAudit({
      org_id: user.org_id,
      entity_type: "USER",
      entity_id: userId,
      agent_or_user: userId,
      action: "PASSWORD_CHANGE_FAILED",
      reason_code: "BAD_CURRENT_PASSWORD",
      reason_comment: "Password change rejected: current password did not match.",
      input_value: { ip, user_agent: userAgent },
    });
    throw new AuthError("INVALID_CURRENT_PASSWORD", 401, "Your current password is not correct.");
  }

  const policy = passwordPolicyError(newPassword, user.email);
  if (policy) throw new AuthError("PASSWORD_POLICY", 422, policy);

  const hash = await hashPassword(newPassword);
  await db.query(`UPDATE users SET password_hash=$1, password_reset_required=false WHERE user_id=$2`, [hash, userId]);

  // Decision Lock 1: every password change is logged with timestamp, IP,
  // user agent (logAudit stamps the timestamp; ip/ua ride input_value).
  await logAudit({
    org_id: user.org_id,
    entity_type: "USER",
    entity_id: userId,
    agent_or_user: userId,
    action: "PASSWORD_CHANGED",
    reason_code: "PASSWORD_CHANGE",
    reason_comment: "Password changed by the account holder.",
    input_value: { ip, user_agent: userAgent },
  });

  // Other devices are signed out; the current session survives so the
  // user is not logged out of the device they just changed the password on.
  await revokeAllSessionsForUser(userId, userId, "PASSWORD_CHANGED", currentSessionId);
}

/**
 * Issues a password-reset token row for a user and delivers the link.
 * Returns which channel(s) the link actually went out on — empty when
 * delivery failed on every channel (always audited).
 */
async function issueAndDeliverResetLink(params: {
  user: UserRow;
  issuedBy: string | null;
  issuedVia: "SELF" | "ADMIN_HANDOFF";
  language: SupportedLanguage;
}): Promise<{ link: string; delivered_via: string[] }> {
  const { user, issuedBy, issuedVia, language } = params;
  const raw = generateToken();
  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, issued_by, issued_via, channel)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5, 'SMS')`,
    [user.user_id, hashToken(raw), RESET_TOKEN_TTL_MS / 1000, issuedBy, issuedVia]
  );
  const link = `${env.APP_PUBLIC_URL}/reset-password?token=${raw}`;
  const message = renderTemplateBody("PASSWORD_RESET_LINK", language, { reset_link: link });

  const deliveredVia: string[] = [];
  // Decision Lock 1: SMS-first, email as fallback.
  if (user.phone) {
    const sms = await dispatchMessage(user.org_id, "SMS", { candidate_id: null, to: user.phone, message }, { template_code: "PASSWORD_RESET_LINK", actor: issuedVia === "ADMIN_HANDOFF" ? "admin_handoff" : "auth_service" });
    if (sms.status === "SENT") deliveredVia.push("SMS");
  }
  if (deliveredVia.length === 0 && user.email) {
    const email = await dispatchMessage(user.org_id, "EMAIL", { candidate_id: null, to: user.email, message }, { template_code: "PASSWORD_RESET_LINK", actor: issuedVia === "ADMIN_HANDOFF" ? "admin_handoff" : "auth_service" });
    if (email.status === "SENT") deliveredVia.push("EMAIL");
  }

  if (deliveredVia.length > 0) {
    await db.query(`UPDATE password_reset_tokens SET channel=$2 WHERE token_hash=$1`, [hashToken(raw), deliveredVia[0] === "SMS" ? "SMS" : "EMAIL"]);
    await logAudit({
      org_id: user.org_id,
      entity_type: "USER",
      entity_id: user.user_id,
      agent_or_user: issuedBy ?? "auth_service",
      action: "PASSWORD_RESET_LINK_ISSUED",
      reason_code: "RESET_LINK_ISSUED",
      reason_comment: `Reset link delivered via ${deliveredVia.join(" then ")}.`,
      input_value: { issued_via: issuedVia },
    });
  } else {
    logger.warn("PASSWORD_RESET_LINK_UNDELIVERED", { user_id: user.user_id, org_id: user.org_id });
    await logAudit({
      org_id: user.org_id,
      entity_type: "USER",
      entity_id: user.user_id,
      agent_or_user: issuedBy ?? "auth_service",
      action: "PASSWORD_RESET_LINK_FAILED",
      reason_code: "DELIVERY_FAILED",
      reason_comment: "Reset link could not be delivered on SMS or email. Use in-person admin handoff.",
      input_value: { issued_via: issuedVia },
    });
  }

  return { link, delivered_via: deliveredVia };
}

/** POST /auth/password/reset/request — anti-enumeration: the route always answers generically. */
export async function requestPasswordReset(email: string, ip: string | null, userAgent: string | null): Promise<{ delivered_via: string[] }> {
  const user = await loadUserByEmail(email);
  if (!user || !user.active) {
    await logAudit({
      org_id: undefined,
      entity_type: "USER",
      entity_id: email,
      agent_or_user: email,
      action: "PASSWORD_RESET_REQUESTED",
      reason_code: "UNKNOWN_EMAIL",
      reason_comment: "Reset requested for an email with no active account; no link sent.",
      input_value: { ip, user_agent: userAgent },
    });
    return { delivered_via: [] };
  }
  const language: SupportedLanguage = user.preferred_language ?? "en";
  const { delivered_via } = await issueAndDeliverResetLink({ user, issuedBy: user.user_id, issuedVia: "SELF", language });
  await logAudit({
    org_id: user.org_id,
    entity_type: "USER",
    entity_id: user.user_id,
    agent_or_user: user.user_id,
    action: "PASSWORD_RESET_REQUESTED",
    reason_code: "RESET_REQUESTED",
    reason_comment: delivered_via.length > 0 ? `Self-service reset requested; link sent via ${delivered_via.join(" then ")}.` : "Self-service reset requested; delivery failed on all channels.",
    input_value: { ip, user_agent: userAgent },
  });
  return { delivered_via };
}

export interface ResetTokenCheck {
  valid: boolean;
  expired: boolean;
}

/** GET /auth/password/reset/verify — marks clicked_at (Decision Lock 1 lifecycle) and reports validity. */
export async function verifyResetToken(rawToken: string): Promise<ResetTokenCheck> {
  const res = await db.query<{ user_id: string; consumed_at: Date | null; expires_at: Date }>(
    `SELECT user_id, consumed_at, expires_at FROM password_reset_tokens WHERE token_hash=$1`,
    [hashToken(rawToken)]
  );
  const row = res.rows[0];
  if (!row || row.consumed_at) return { valid: false, expired: false };
  if (row.expires_at.getTime() <= Date.now()) return { valid: false, expired: true };
  await db.query(`UPDATE password_reset_tokens SET clicked_at=COALESCE(clicked_at, now()) WHERE token_hash=$1`, [hashToken(rawToken)]);
  return { valid: true, expired: false };
}

/** POST /auth/password/reset/confirm */
export async function confirmPasswordReset(rawToken: string, newPassword: string, ip: string | null, userAgent: string | null): Promise<{ user_id: string; org_id: string }> {
  const res = await db.query<{ user_id: string; consumed_at: Date | null; expires_at: Date }>(
    `SELECT user_id, consumed_at, expires_at FROM password_reset_tokens WHERE token_hash=$1`,
    [hashToken(rawToken)]
  );
  const row = res.rows[0];
  if (!row || row.consumed_at) throw new AuthError("RESET_TOKEN_INVALID", 400, "This reset link is not valid. Request a new one.");
  if (row.expires_at.getTime() <= Date.now()) throw new AuthError("RESET_TOKEN_EXPIRED", 400, "This reset link has expired. Request a new one.");

  const user = await loadUserById(row.user_id);
  if (!user || !user.active) throw new AuthError("RESET_TOKEN_INVALID", 400, "This reset link is not valid. Request a new one.");

  const policy = passwordPolicyError(newPassword, user.email);
  if (policy) throw new AuthError("PASSWORD_POLICY", 422, policy);

  const hash = await hashPassword(newPassword);
  await db.query(
    `UPDATE users SET password_hash=$1, password_reset_required=false, email_verified_at=now() WHERE user_id=$2`,
    [hash, user.user_id]
  );
  await db.query(
    `UPDATE password_reset_tokens SET consumed_at=now(), clicked_at=COALESCE(clicked_at, now()) WHERE token_hash=$1`,
    [hashToken(rawToken)]
  );

  await logAudit({
    org_id: user.org_id,
    entity_type: "USER",
    entity_id: user.user_id,
    agent_or_user: user.user_id,
    action: "PASSWORD_RESET_COMPLETED",
    reason_code: "RESET_COMPLETED",
    reason_comment: "Password set via reset link. All existing sessions were revoked.",
    input_value: { ip, user_agent: userAgent },
  });

  // A set password invalidates every existing session — the account
  // holder signs in fresh on each device.
  await revokeAllSessionsForUser(user.user_id, user.user_id, "PASSWORD_RESET");
  return { user_id: user.user_id, org_id: user.org_id };
}

const INVITABLE_ROLES: UserRole[] = ["ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "DEPT_HEAD"];

/** POST /users/invite — admin creates a staff user; the person sets their own password via link. */
export async function inviteUser(
  admin: { user_id: string; org_id: string },
  input: { email: string; full_name: string; role: UserRole; phone?: string | null; dept_scope?: string | null },
  ip: string | null,
  userAgent: string | null
): Promise<{ user: AuthenticatedUserInfo; link: string; delivered_via: string[] }> {
  if (!INVITABLE_ROLES.includes(input.role)) {
    throw new AuthError("ROLE_NOT_INVITABLE", 422, "This role cannot be invited to the staff dashboard.");
  }
  try {
    const inserted = await db.query<UserRow>(
      `INSERT INTO users (org_id, full_name, email, phone, role, dept_scope, password_reset_required)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING user_id, org_id, role, full_name, email, preferred_language, password_reset_required, active, password_hash, phone`,
      [admin.org_id, input.full_name, input.email, input.phone ?? null, input.role, input.dept_scope ?? null]
    );
    const user = inserted.rows[0];

    const language: SupportedLanguage = "en";
    const { link, delivered_via } = await issueAndDeliverResetLink({ user, issuedBy: admin.user_id, issuedVia: "ADMIN_HANDOFF", language });

    await logAudit({
      org_id: admin.org_id,
      entity_type: "USER",
      entity_id: user.user_id,
      agent_or_user: admin.user_id,
      action: "USER_INVITED",
      reason_code: "INVITE",
      reason_comment: delivered_via.length > 0 ? `Invite link delivered via ${delivered_via.join(" then ")}.` : "Invite created; delivery failed — share the link in person.",
      input_value: { email: input.email, role: input.role, ip, user_agent: userAgent },
    });

    return { user: userRowToInfo(user), link, delivered_via };
  } catch (err) {
    if (err instanceof Error && /duplicate key value|unique constraint/i.test(err.message)) {
      throw new AuthError("EMAIL_IN_USE", 409, "A user with this email already exists.");
    }
    throw err;
  }
}

/**
 * Admin in-person handoff (Decision Lock 1): generates a set-password
 * link and returns the raw string exactly once — it is never stored raw,
 * only its hash. The admin shows it as a QR code / copyable string.
 */
export async function issueAdminResetLink(admin: { user_id: string; org_id: string }, targetUserId: string): Promise<{ link: string; expires_in_minutes: number }> {
  const user = await loadUserById(targetUserId);
  if (!user || !user.active) throw new AuthError("USER_NOT_FOUND", 404, "Account not found.");
  if (user.org_id !== admin.org_id) throw new AuthError("USER_NOT_FOUND", 404, "Account not found.");

  const { link } = await issueAndDeliverResetLink({ user, issuedBy: admin.user_id, issuedVia: "ADMIN_HANDOFF", language: user.preferred_language ?? "en" });
  return { link, expires_in_minutes: RESET_TOKEN_TTL_MS / 60000 };
}

/** Admin revokes all sessions for a target user in the same org. */
export async function adminRevokeAllSessions(admin: { user_id: string; org_id: string }, targetUserId: string): Promise<number> {
  const target = await loadUserById(targetUserId);
  if (!target || target.org_id !== admin.org_id) throw new AuthError("USER_NOT_FOUND", 404, "Account not found.");
  const revoked = await revokeAllSessionsForUser(targetUserId, admin.user_id, "ADMIN_REVOKED");
  await logAudit({
    org_id: admin.org_id,
    entity_type: "USER",
    entity_id: targetUserId,
    agent_or_user: admin.user_id,
    action: "SESSIONS_REVOKED_BY_ADMIN",
    reason_code: "ADMIN_REVOKED",
    reason_comment: `Admin revoked ${revoked} active session(s).`,
  });
  return revoked;
}
