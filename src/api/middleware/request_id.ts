import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";

/**
 * Assigns every request a stable request ID for correlating structured
 * logs, audit entries, and error responses end-to-end. Honors an inbound
 * `X-Request-Id` header (e.g. set by an upstream load balancer or
 * reverse proxy) so traces stay correlated across hops; otherwise
 * generates a new UUID v4. Always echoed back on the response so callers
 * can quote it when filing a support ticket.
 *
 * Must run before `requestLogger` and before any route handler so that
 * `req.requestId` is available everywhere downstream, including the
 * error handler.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers["x-request-id"];
  const id = typeof incoming === "string" && incoming.trim().length > 0 ? incoming.trim() : randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
