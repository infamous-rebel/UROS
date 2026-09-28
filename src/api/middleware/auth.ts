import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.schema";
import { logger } from "../../utils/logger";
import { AuthenticatedUser } from "../types/express";

interface JwtClaims {
  user_id: string;
  org_id: string;
  role: AuthenticatedUser["role"];
  iat?: number;
  exp?: number;
}

/**
 * Verifies a Bearer JWT and attaches req.user.
 * Rejects missing, malformed, expired, or invalid-signature tokens with 401.
 */
export function authenticate(req: Request, res: Response, next: NextFunction): void {
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

    req.user = {
      user_id: decoded.user_id,
      org_id: decoded.org_id,
      role: decoded.role,
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
