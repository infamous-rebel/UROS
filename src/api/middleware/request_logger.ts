import { Request, Response, NextFunction } from "express";
import { logger } from "../../utils/logger";
import { metrics } from "../../utils/metrics";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    // Prefer the matched Express route pattern (e.g. "/candidates/:id")
    // over the raw path so metrics don't explode in cardinality with one
    // series per candidate ID. Falls back to the raw path for unmatched
    // (404) requests, where no route pattern exists.
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;

    logger.info("HTTP_REQUEST", {
      request_id: req.requestId,
      method: req.method,
      path: req.originalUrl,
      route,
      status: res.statusCode,
      duration_ms: durationMs,
      user_id: req.user?.user_id,
      org_id: req.user?.org_id,
    });

    metrics.httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
    metrics.httpRequestDurationMs.observe({ method: req.method, route }, durationMs);
  });
  next();
}
