/**
 * Token bucket rate limiter per provider, per org.
 * In-memory per API process. Refills tokens continuously over the window.
 */

import type { RateLimitConfig } from "./types";

interface BucketEntry {
  tokens: number;
  last_refill: number;
}

/** In-memory bucket store, keyed by `${orgId}:${provider}`. */
const buckets = new Map<string, BucketEntry>();

/** Per-org, per-provider configs. */
const configs = new Map<string, RateLimitConfig>();

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  max_requests: 100,
  window_ms: 60_000,
};

function bucketKey(orgId: string, provider: string): string {
  return `${orgId}:${provider}`;
}

function getConfig(orgId: string, provider: string): RateLimitConfig {
  return configs.get(bucketKey(orgId, provider)) ?? DEFAULT_RATE_LIMIT;
}

function refillTokens(entry: BucketEntry, config: RateLimitConfig): void {
  const now = Date.now();
  const elapsed = now - entry.last_refill;
  const tokensPerMs = config.max_requests / config.window_ms;
  const newTokens = elapsed * tokensPerMs;
  entry.tokens = Math.min(config.max_requests, entry.tokens + newTokens);
  entry.last_refill = now;
}

/** Set rate limit config for an org+provider. */
export function setConfig(orgId: string, provider: string, config: RateLimitConfig): void {
  configs.set(bucketKey(orgId, provider), config);
  // Reset the bucket when config changes
  buckets.delete(bucketKey(orgId, provider));
}

/**
 * Try to consume a token. Returns true if allowed, false if rate limited.
 */
export function tryConsume(orgId: string, provider: string): boolean {
  const key = bucketKey(orgId, provider);
  const config = getConfig(orgId, provider);

  let entry = buckets.get(key);
  if (!entry) {
    entry = { tokens: config.max_requests, last_refill: Date.now() };
    buckets.set(key, entry);
  }

  refillTokens(entry, config);

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    return true;
  }

  return false;
}

/** Get the current token count for an org+provider (for admin dashboard). */
export function getRemainingTokens(orgId: string, provider: string): number {
  const key = bucketKey(orgId, provider);
  const config = getConfig(orgId, provider);

  const entry = buckets.get(key);
  if (!entry) return config.max_requests;

  refillTokens(entry, config);
  return Math.floor(entry.tokens);
}

/** Get all rate limit states (for admin dashboard). */
export function getAllRateLimitStates(): Array<{
  org_id: string;
  provider: string;
  remaining: number;
  max: number;
}> {
  return Array.from(buckets.entries()).map(([key, entry]) => {
    const [orgId, ...providerParts] = key.split(":");
    const provider = providerParts.join(":");
    const config = getConfig(orgId, provider);
    refillTokens(entry, config);
    return {
      org_id: orgId,
      provider,
      remaining: Math.floor(entry.tokens),
      max: config.max_requests,
    };
  });
}

/** Reset all rate limit state (test-only). */
export function resetAllRateLimits(): void {
  buckets.clear();
  configs.clear();
}
