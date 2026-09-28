import { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * In-memory fixed-window rate limiter. Keyed by (route key + user_id or IP).
 * Assumption: single-process deployment for this reference implementation.
 * For multi-instance/horizontal scaling (see file 20 §8.3), swap the store
 * for Redis (env.REDIS_URL is already validated in config for this purpose)
 * without changing the middleware call sites.
 */
const buckets = new Map<string, Bucket>();

export function createRateLimiter(routeKey: string, maxRequests: number, windowMs: number = 60_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = req.user?.user_id ?? req.ip ?? "anonymous";
    const key = `${routeKey}:${identity}`;
    const now = Date.now();

    const bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      buckets.set(key, { count: 1, windowStart: now });
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      const retryAfterMs = windowMs - (now - bucket.windowStart);
      res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000).toString());
      res.status(429).json({
        error: "Rate limit exceeded",
        route: routeKey,
        limit: maxRequests,
        window_ms: windowMs,
      });
      return;
    }

    bucket.count += 1;
    next();
  };
}

// Presets per file 20 §5.7 rate limit table
export const importRateLimit = createRateLimiter("import", 10, 60_000);
export const candidateQueryRateLimit = createRateLimiter("candidate_query", 100, 60_000);
export const communicationSendRateLimit = createRateLimiter("communication_send", 30, 60_000);
export const reportGenerationRateLimit = createRateLimiter("report_generation", 10, 60_000);

/** Periodic sweep to prevent unbounded map growth in long-running processes. */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.windowStart > 5 * 60_000) buckets.delete(key);
  }
}, 5 * 60_000).unref();
