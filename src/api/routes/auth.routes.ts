/**
 * Auth routes — Quest 05 Part 1.
 *
 * Refresh tokens ride an httpOnly cookie scoped to /api/v1/auth (Decision
 * Lock 2: never localStorage). Access tokens are returned in the body and
 * held in memory by the UI only. Every response shape is documented in
 * docs/api.md (Quest 05 Part 13).
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import {
  AuthError,
  changePassword,
  confirmPasswordReset,
  getCurrentUser,
  listUserOrgs,
  login,
  logout,
  logoutAll,
  refreshAccess,
  requestPasswordReset,
  switchOrg,
  verifyResetToken,
} from "../../services/auth/service";
import { REFRESH_TOKEN_TTL_MS } from "../../services/auth/sessions";

const router = Router();

const REFRESH_COOKIE = "uros_refresh";

const isProduction = env.NODE_ENV === "production";

function setRefreshCookie(res: Response, rawToken: string, remember = true): void {
  res.cookie(REFRESH_COOKIE, rawToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    path: "/api/v1/auth",
    // "Remember me" unchecked → browser-session cookie: it disappears
    // when the browser closes, shortening the practical session without
    // touching the server-side absolute expiry (Decision Lock 2).
    maxAge: remember ? REFRESH_TOKEN_TTL_MS : undefined,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
}

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

function clientUserAgent(req: Request): string | null {
  return req.headers["user-agent"] ?? null;
}

function handleAuthError(err: unknown, res: Response): void {
  if (err instanceof AuthError) {
    res.status(err.httpStatus).json({ error: err.message, error_code: err.code });
    return;
  }
  logger.error("AUTH_ROUTE_ERROR", { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "Something went wrong. Please try again.", error_code: "INTERNAL" });
}

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // Optional for backward compatibility with earlier clients; default is
  // the full 7-day cookie (checked checkbox).
  remember_me: z.boolean().optional(),
});

/**
 * POST /api/v1/auth/login — email + password.
 * Returns the access token + user; sets the refresh cookie.
 */
router.post("/login", validate({ body: LoginSchema }), async (req: Request, res: Response) => {
  try {
    const { email, password, remember_me: remember } = req.body as z.infer<typeof LoginSchema>;
    const result = await login(email, password, clientIp(req), clientUserAgent(req));
    setRefreshCookie(res, result.refresh_token, remember ?? true);
    res.status(200).json({
      access_token: result.access_token,
      expires_in: result.expires_in,
      user: result.user,
    });
  } catch (err) {
    handleAuthError(err, res);
  }
});

/**
 * GET /api/v1/auth/me — the signed-in person's own profile. Used by the
 * dashboard after a cookie-based boot refresh, when the login response
 * (which carries the user object) never happened in this browser session.
 */
router.get("/me", authenticate, async (req: Request, res: Response) => {
  try {
    const user = await getCurrentUser(req.user!.user_id, req.user!.org_id);
    if (!user) {
      res.status(404).json({ error: "Account not found.", error_code: "USER_NOT_FOUND" });
      return;
    }
    res.status(200).json({ user });
  } catch (err) {
    handleAuthError(err, res);
  }
});

/**
 * POST /api/v1/auth/refresh — rotates the refresh token (old one is
 * invalidated the moment the new one is issued) and returns a fresh
 * access token. Replay of a rotated token revokes the whole session.
 */
router.post("/refresh", async (req: Request, res: Response) => {
  const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!raw) {
    res.status(401).json({ error: "No session to refresh.", error_code: "REFRESH_INVALID" });
    return;
  }
  try {
    const result = await refreshAccess(raw);
    setRefreshCookie(res, result.refresh_token);
    res.status(200).json({
      access_token: result.access_token,
      expires_in: result.expires_in,
      user: result.user,
    });
  } catch (err) {
    clearRefreshCookie(res);
    handleAuthError(err, res);
  }
});

/** POST /api/v1/auth/logout — revokes the current session; clears the cookie. */
router.post("/logout", authenticate, async (req: Request, res: Response) => {
  try {
    const sessionId = req.user!.session_id;
    if (!sessionId) {
      res.status(400).json({ error: "This token has no session to log out.", error_code: "NO_SESSION" });
      return;
    }
    await logout(req.user!.user_id, sessionId, req.user!.org_id);
    clearRefreshCookie(res);
    res.status(200).json({ ok: true });
  } catch (err) {
    handleAuthError(err, res);
  }
});

/** POST /api/v1/auth/logout-all — revokes every session for the current user. */
router.post("/logout-all", authenticate, async (req: Request, res: Response) => {
  try {
    const revoked = await logoutAll(req.user!.user_id, req.user!.org_id);
    clearRefreshCookie(res);
    res.status(200).json({ ok: true, revoked_sessions: revoked });
  } catch (err) {
    handleAuthError(err, res);
  }
});

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(1),
});

/** POST /api/v1/auth/password/change — requires the current password. */
router.post("/password/change", authenticate, validate({ body: ChangePasswordSchema }), async (req: Request, res: Response) => {
  try {
    const sessionId = req.user!.session_id;
    if (!sessionId) {
      res.status(400).json({ error: "Password change requires an interactive session.", error_code: "NO_SESSION" });
      return;
    }
    const { current_password, new_password } = req.body as z.infer<typeof ChangePasswordSchema>;
    await changePassword(req.user!.user_id, current_password, new_password, clientIp(req), clientUserAgent(req), sessionId);
    res.status(200).json({ ok: true });
  } catch (err) {
    handleAuthError(err, res);
  }
});

const ResetRequestSchema = z.object({
  email: z.string().email(),
});

/**
 * POST /api/v1/auth/password/reset/request — always answers generically
 * so the endpoint cannot be used to discover which emails exist.
 */
router.post("/password/reset/request", validate({ body: ResetRequestSchema }), async (req: Request, res: Response) => {
  try {
    const { email } = req.body as z.infer<typeof ResetRequestSchema>;
    await requestPasswordReset(email, clientIp(req), clientUserAgent(req));
    res.status(200).json({
      message: "If an account exists for that email, a reset link has been sent by SMS (or email if no phone number is on file).",
    });
  } catch (err) {
    handleAuthError(err, res);
  }
});

/** GET /api/v1/auth/password/reset/verify?token=… — marks the link as clicked and reports validity. */
router.get("/password/reset/verify", async (req: Request, res: Response) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) {
      res.status(400).json({ valid: false, expired: false, error: "Missing reset token." });
      return;
    }
    const check = await verifyResetToken(token);
    res.status(200).json(check);
  } catch (err) {
    handleAuthError(err, res);
  }
});

const ResetConfirmSchema = z.object({
  token: z.string().min(1),
  new_password: z.string().min(1),
});

/** POST /api/v1/auth/password/reset/confirm — sets the new password, consumes the link. */
router.post("/password/reset/confirm", validate({ body: ResetConfirmSchema }), async (req: Request, res: Response) => {
  try {
    const { token, new_password } = req.body as z.infer<typeof ResetConfirmSchema>;
    const result = await confirmPasswordReset(token, new_password, clientIp(req), clientUserAgent(req));
    res.status(200).json({ ok: true, org_id: result.org_id });
  } catch (err) {
    handleAuthError(err, res);
  }
});

/**
 * GET /api/v1/auth/orgs — Quest 05 Part 2 org switcher: every org the
 * person belongs to, with the active one flagged.
 */
router.get("/orgs", authenticate, async (req: Request, res: Response) => {
  try {
    const orgs = await listUserOrgs(req.user!.user_id, req.user!.org_id);
    res.status(200).json({ orgs });
  } catch (err) {
    handleAuthError(err, res);
  }
});

/**
 * POST /api/v1/auth/orgs/:orgId/switch — Quest 05 Part 2 "switch reloads
 * session". Validates membership, persists the preference, rotates the
 * session, and returns a fresh access token + cookie with the new org claim.
 */
router.post("/orgs/:orgId/switch", authenticate, async (req: Request, res: Response) => {
  try {
    const { orgId } = req.params;
    const result = await switchOrg(req.user!.user_id, orgId, req.user!.session_id, clientIp(req), clientUserAgent(req));
    setRefreshCookie(res, result.refresh_token);
    res.status(200).json({
      access_token: result.access_token,
      expires_in: result.expires_in,
      user: result.user,
    });
  } catch (err) {
    handleAuthError(err, res);
  }
});

export default router;
