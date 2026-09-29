/**
 * Exponential backoff with jitter for adapter send retries.
 * Deterministic base delay: baseDelayMs * 2^(attempt-1), capped at maxDelayMs.
 * Jitter adds a random 0–25% variance to prevent thundering-herd sync.
 */

import type { RetryConfig } from "./types";
import { logger } from "../../../utils/logger";

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  max_attempts: 4,
  base_delay_ms: 500,
  max_delay_ms: 8_000,
};

/**
 * Compute the delay for a given attempt number (1-based).
 * Deterministic base: baseDelayMs * 2^(attempt-1), capped at maxDelayMs.
 * With jitter: adds 0–25% random variance.
 */
export function computeDelayMs(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  jitter: boolean = true
): number {
  const base = config.base_delay_ms * Math.pow(2, attempt - 1);
  const capped = Math.min(base, config.max_delay_ms);
  if (!jitter) return capped;
  const jitterRange = capped * 0.25;
  return capped + Math.random() * jitterRange;
}

type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute an async operation with retry + exponential backoff.
 * Only retries on transient failures (the function throws).
 * Returns the result on first success.
 * Throws the last error once max_attempts is exhausted.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  sleepFn: SleepFn = defaultSleep,
  context?: string
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.max_attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < config.max_attempts) {
        const delayMs = computeDelayMs(attempt, config);
        logger.warn("INTEGRATION_RETRY_ATTEMPT", {
          context: context ?? "unknown",
          attempt,
          max_attempts: config.max_attempts,
          delay_ms: Math.round(delayMs),
          error: lastError.message,
        });
        await sleepFn(delayMs);
      }
    }
  }

  throw lastError;
}
