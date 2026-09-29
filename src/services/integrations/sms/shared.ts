/**
 * Shared HTTP SMS adapter factory.
 *
 * Every SMS provider adapter is a thin profile over this factory: it declares
 * the provider's documented request/response contract and the factory supplies
 * the uniform Integration behaviour (single send attempt, structured result,
 * health probe).
 *
 * Transport contract (all adapters):
 * - Definitive API rejection (4xx / provider error payload) → returns
 *   `IntegrationResult` with status FAILED and a stable error_code. NOT retried
 *   by the dispatcher.
 * - Transient failure (network error, 5xx) → THROWS. The dispatcher's retry
 *   layer handles backoff; the circuit breaker records the failure.
 * - Config comes exclusively from BYOK credentials ({ apiKey, baseUrl }).
 *   Missing credentials → ProviderCredentialError (via credential_store).
 *   Providers without a stable canonical host REQUIRE baseUrl — a missing
 *   baseUrl is a malformed credential and throws (Rule 18: never fall back
 *   to a default endpoint silently).
 */

import {
  Integration,
  IntegrationResult,
  ProviderCredentialError,
  SmsInput,
  SmsOutput,
} from "../_base/types";

/** Uniform adapter config resolved from the org's BYOK credential. */
export interface HttpProviderConfig {
  apiKey: string;
  baseUrl: string | null;
  /** Owning org — used for structured credential errors. */
  orgId: string;
}

/** Thrown when an adapter that requires a configured baseUrl has none. */
export class MissingBaseUrlError extends ProviderCredentialError {
  constructor(provider: string, orgId: string) {
    super(
      provider,
      orgId,
      `baseUrl is required for provider '${provider}'. The credential's base_url must point at the provider's contracted endpoint.`
    );
    this.name = "MissingBaseUrlError";
  }
}

export interface SmsHttpRequest {
  url: string;
  init: RequestInit;
}

/** Per-provider contract profile. */
export interface SmsProviderProfile {
  /** Build the provider's documented HTTP request for one SMS. */
  buildRequest(input: SmsInput, config: HttpProviderConfig): SmsHttpRequest;
  /** Parse a successful (2xx) provider response into provider_message_id. */
  parseSuccess(bodyText: string): SmsOutput;
  /** URL used by healthCheck (GET). Defaults to the send URL's origin. */
  healthUrl?(config: HttpProviderConfig): string;
  /** True when the provider has no canonical host (baseUrl then required). */
  requiresBaseUrl?: boolean;
}

/** Providers whose response is JSON with one of the common id fields. */
export function parseJsonIdField(bodyText: string): SmsOutput {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  const id =
    body.message_id ?? body.messageId ?? body.msg_id ?? body.id ?? body.sms_id ?? body.transactionId;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new Error(`Provider response missing message id field: ${bodyText.slice(0, 200)}`);
  }
  return { provider_message_id: String(id) };
}

/** Run one provider-profiled send attempt. Throws on transient failure. */
async function sendOnce(
  profile: SmsProviderProfile,
  input: SmsInput,
  config: HttpProviderConfig
): Promise<IntegrationResult<SmsOutput>> {
  let res: Response;
  try {
    const req = profile.buildRequest(input, config);
    res = await fetch(req.url, req.init);
  } catch (err) {
    // Network-level failure is transient: throw for the dispatcher's retry.
    throw err instanceof Error ? err : new Error(String(err));
  }

  const bodyText = await res.text();
  if (res.status >= 500) {
    // Server-side failure is transient: throw for the dispatcher's retry
    // layer. The circuit breaker records the failure on this connector.
    throw new Error(`SMS gateway responded ${res.status}: ${res.statusText}; body: ${bodyText.slice(0, 200)}`);
  }
  if (!res.ok) {
    return {
      status: "FAILED",
      error_code: `HTTP_${res.status}`,
      error_message: `SMS gateway responded ${res.status}: ${res.statusText}; body: ${bodyText.slice(0, 200)}`,
    };
  }

  try {
    const output = profile.parseSuccess(bodyText);
    // provider_id mirrors data.provider_message_id — the dispatcher persists
    // it into communication_log.provider_message_id for provider tracking.
    return { status: "SENT", provider_id: output.provider_message_id, data: output };
  } catch (err) {
    // Malformed success response — treat as provider-side failure, not transient.
    return {
      status: "FAILED",
      error_code: "MALFORMED_PROVIDER_RESPONSE",
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build a uniform SMS Integration adapter from a provider profile. */
export function makeHttpSmsAdapter(name: string, profile: SmsProviderProfile): Integration<HttpProviderConfig, SmsInput, SmsOutput> {
  return {
    name,
    async send(input: SmsInput, config: HttpProviderConfig): Promise<IntegrationResult<SmsOutput>> {
      if (profile.requiresBaseUrl && !config.baseUrl) {
        throw new MissingBaseUrlError(name, config.orgId);
      }
      return sendOnce(profile, input, config);
    },
    async healthCheck(config: HttpProviderConfig): Promise<boolean> {
      const url = profile.healthUrl
        ? profile.healthUrl(config)
        : new URL(profile.buildRequest({ to: "", message: "" }, config).url).origin;
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        return res.status < 500;
      } catch {
        return false;
      }
    },
  };
}
