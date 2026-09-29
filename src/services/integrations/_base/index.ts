/**
 * Base infrastructure barrel export.
 * Uniform adapter interface, registry, retry, circuit breaker,
 * rate limit, fallback chain, and credential resolution.
 */

export {
  type Integration,
  type IntegrationResult,
  type DeliveryStatus,
  type SmsInput,
  type SmsOutput,
  type EmailInput,
  type EmailOutput,
  type WhatsAppInput,
  type WhatsAppOutput,
  type RateLimitConfig,
  type CircuitBreakerConfig,
  type RetryConfig,
  ProviderCredentialError,
  ProviderNotImplementedError,
} from "./types";

export {
  registerProvider,
  getProvider,
  listProviders,
  listAllProviders,
  clearRegistry,
  CONNECTOR_TO_ADAPTER,
  resolveConnectorName,
  listConnectorNames,
} from "./registry";

export { computeDelayMs, withRetry, DEFAULT_RETRY_CONFIG } from "./retry";

export {
  type CircuitState,
  getState as getCircuitState,
  allowRequest,
  recordSuccess as recordCircuitSuccess,
  recordFailure as recordCircuitFailure,
  resetAllCircuits,
  getAllCircuitStates,
} from "./circuit_breaker";

export {
  tryConsume as tryConsumeRateLimit,
  getRemainingTokens,
  getAllRateLimitStates,
  resetAllRateLimits,
} from "./rate_limit";

export {
  resolveFallbackChain,
  setFallbackChain,
  getFallbackConfig,
  type FallbackChainEntry,
} from "./fallback";

export {
  resolveAdapterCredential,
  hasCredential,
  MissingCredentialError,
} from "./credentials";
