/**
 * Uniform adapter interface for all UROS integrations.
 * Every provider (SMS, email, WhatsApp, bdjobs, calendar, LinkedIn, VOIP)
 * implements this contract so the communication agent, fallback resolver,
 * and registry can treat them interchangeably.
 */

/** Successful delivery states. */
export type DeliveryStatus = "QUEUED" | "SENT" | "DELIVERED";

/** Structured result from any adapter send() call. */
export type IntegrationResult<TOutput = void> =
  | {
      status: DeliveryStatus;
      provider_id?: string;
      data?: TOutput;
    }
  | {
      status: "FAILED";
      error_code: string;
      error_message: string;
    };

/**
 * The uniform adapter contract. TConfig is the provider-specific
 * configuration shape (resolved from BYOK credentials). TInput is what
 * callers pass to send(). TOutput is provider-specific response data.
 */
export interface Integration<TConfig, TInput, TOutput = void> {
  /** Stable provider name (e.g. "teletalk", "smtp_outbound"). */
  readonly name: string;

  /** Send a message / make a call through this provider. */
  send(input: TInput, config: TConfig): Promise<IntegrationResult<TOutput>>;

  /** Lightweight health check — confirms the provider is reachable. */
  healthCheck(config: TConfig): Promise<boolean>;
}

/**
 * Thrown when an adapter is invoked but the org's BYOK credential is
 * missing or malformed. Adapters NEVER silently fall back to a mock,
 * default endpoint, or no-op — they throw this.
 */
export class ProviderCredentialError extends Error {
  constructor(
    public readonly provider: string,
    public readonly orgId: string,
    public readonly detail: string
  ) {
    super(`Provider '${provider}' credential error for org ${orgId}: ${detail}`);
    this.name = "ProviderCredentialError";
  }
}

/**
 * Thrown by interface-only adapters (free_framework, telegram, viber, signal)
 * when send() is called. These are complete interface implementations awaiting
 * a live provider contribution — not stubs.
 */
export class ProviderNotImplementedError extends Error {
  constructor(public readonly provider: string) {
    super(
      `Provider '${provider}' is an interface-only adapter. ` +
        `No live implementation has been contributed yet. ` +
        `Implement the Integration interface and register it via the adapter registry.`
    );
    this.name = "ProviderNotImplementedError";
  }
}

/** Common SMS input shape shared across SMS adapters. */
export interface SmsInput {
  to: string;
  message: string;
  sender_id?: string;
}

/** Common SMS output shape. */
export interface SmsOutput {
  provider_message_id: string;
  segments?: number;
}

/** Common email input shape. */
export interface EmailInput {
  to: string;
  subject: string;
  body_text: string;
  body_html?: string;
  from?: string;
  attachments?: Array<{ filename: string; content_type: string; data: Buffer }>;
}

/** Common email output shape. */
export interface EmailOutput {
  provider_message_id: string;
}

/** Common WhatsApp input shape. */
export interface WhatsAppInput {
  to: string;
  template_name: string;
  template_params: Record<string, string>;
  language?: string;
}

/** Common WhatsApp output shape. */
export interface WhatsAppOutput {
  provider_message_id: string;
}

/** Rate limit configuration per provider. */
export interface RateLimitConfig {
  /** Maximum requests per window. */
  max_requests: number;
  /** Window duration in milliseconds. */
  window_ms: number;
}

/** Circuit breaker configuration per provider. */
export interface CircuitBreakerConfig {
  /** Consecutive failures before circuit opens. */
  failure_threshold: number;
  /** Milliseconds before a half-open probe is admitted. */
  reset_timeout_ms: number;
}

/** Retry configuration per provider. */
export interface RetryConfig {
  /** Maximum send attempts (including the first). */
  max_attempts: number;
  /** Base delay in ms for exponential backoff. */
  base_delay_ms: number;
  /** Maximum delay cap in ms. */
  max_delay_ms: number;
}
