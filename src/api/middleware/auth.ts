import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import { AuthenticatedUser } from "../types/express";
import { touchSession, validateSession } from "../../services/auth/sessions";

interface JwtClaims {
  user_id: string;
  org_id: string;
  role: AuthenticatedUser["role"];
  /** Present on session-bound (human login) tokens. Absent on service tokens. */
  session_id?: string;
  iat?: number;
  exp?: number;
}

/**
 * Verifies a Bearer JWT and attaches req.user.
 * Rejects missing, malformed, expired, or invalid-signature tokens with 401.
 *
 * Session binding (Quest 05 Decision Lock 2): tokens minted by a human
 * login carry a `session_id` claim and are validated against the live
 * session row on every request — a revoked session, an idle timeout
 * (12h) or absolute expiry (30d) rejects the request even while the JWT
 * itself is unexpired. `last_used_at` is touched with a per-minute
 * throttle to avoid a write per request.
 *
 * Tokens WITHOUT a `session_id` claim are stateless service tokens
 * (e.g. the applicant-portal OTP token minted inside
 * applicant_portal_agent) that can only be produced by a holder of
 * JWT_SECRET — i.e. server-side code. They keep the pre-Quest-05
 * stateless verification path.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const token = header.slice("Bearer ".length).trim();

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as JwtClaims;

    if (!decoded.user_id || !decoded.org_id || !decoded.role) {
      res.status(401).json({ error: "Token missing required claims" });
      return;
    }

    if (decoded.session_id) {
      const session = await validateSession(decoded.session_id);
      if (!session) {
        logger.warn("AUTH_SESSION_INVALID", { path: req.path, method: req.method, session_id: decoded.session_id });
        res.status(401).json({ error: "Session ended", error_code: "SESSION_ENDED" });
        return;
      }
      // Fire-and-forget touch: a slow/throttled update must never delay
      // or fail the request it is observing.
      void touchSession(decoded.session_id).catch((err: unknown) => {
        logger.warn("AUTH_SESSION_TOUCH_FAILED", { error: err instanceof Error ? err.message : String(err) });
      });
    }

    req.user = {
      user_id: decoded.user_id,
      org_id: decoded.org_id,
      role: decoded.role,
      session_id: decoded.session_id,
    };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // Security Hardening Round: previously silent. Expired-token
      // attempts are ordinary (clients refresh routinely) so this logs
      // at warn, not error, but is now observable for rate/pattern
      // monitoring. Never logs the token itself.
      logger.warn("AUTH_TOKEN_EXPIRED", { path: req.path, method: req.method, expiredAt: err.expiredAt });
      res.status(401).json({ error: "Token expired" });
      return;
    }
    if (err instanceof jwt.JsonWebTokenError) {
      // Security Hardening Round: invalid-signature/malformed-token
      // attempts are the more security-relevant case (tampering,
      // forged tokens, brute force) and were previously never logged
      // at all — this closes that observability gap.
      logger.warn("AUTH_TOKEN_INVALID", { path: req.path, method: req.method, reason: err.message });
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    logger.error("AUTH_MIDDLEWARE_ERROR", { error: err instanceof Error ? err.message : String(err) });
    res.status(401).json({ error: "Authentication failed" });
  }
}
