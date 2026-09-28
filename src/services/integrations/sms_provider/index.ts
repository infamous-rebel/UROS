import { requireCredential } from "../credential_store";
import { db } from "../../../database/client";
import { logAudit } from "../../../utils/audit_helper";
import { logger } from "../../../utils/logger";

export interface SmsSendResult {
  candidate_id: string;
  phone: string;
  status: "SENT" | "FAILED";
  attempts: number;
  last_error?: string;
}

export interface SmsRecipient {
  candidate_id: string;
  phone: string;
  message: string;
}

interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryConfig = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8_000 };

/** Deterministic exponential backoff with a hard cap: baseDelay * 2^(attempt-1), capped. */
export function computeBackoffDelayMs(attempt: number, config: RetryConfig = DEFAULT_RETRY): number {
  const delay = config.baseDelayMs * Math.pow(2, attempt - 1);
  return Math.min(delay, config.maxDelayMs);
}

type SendFn = (phone: string, message: string, apiKey: string, baseUrl: string | null) => Promise<void>;
type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function defaultSend(phone: string, message: string, apiKey: string, baseUrl: string | null): Promise<void> {
  const res = await fetch(`${baseUrl ?? "https://api.smsgateway.example.bd"}/v1/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: phone, message }),
  });
  if (!res.ok) {
    throw new Error(`SMS gateway responded ${res.status}: ${res.statusText}`);
  }
}

/**
 * Sends a single SMS with retry + exponential backoff. Exposes injectable
 * `sendFn`/`sleepFn` so tests can run deterministically without real
 * network calls or real timers.
 */
export async function sendWithRetry(
  recipient: SmsRecipient,
  apiKey: string,
  baseUrl: string | null,
  config: RetryConfig = DEFAULT_RETRY,
  sendFn: SendFn = defaultSend,
  sleepFn: SleepFn = defaultSleep
): Promise<SmsSendResult> {
  let attempt = 0;
  let lastError: string | undefined;

  while (attempt < config.maxAttempts) {
    attempt += 1;
    try {
      await sendFn(recipient.phone, recipient.message, apiKey, baseUrl);
      return { candidate_id: recipient.candidate_id, phone: recipient.phone, status: "SENT", attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn("SMS_SEND_ATTEMPT_FAILED", {
        candidate_id: recipient.candidate_id,
        attempt,
        maxAttempts: config.maxAttempts,
        error: lastError,
      });
      if (attempt < config.maxAttempts) {
        await sleepFn(computeBackoffDelayMs(attempt, config));
      }
    }
  }

  return {
    candidate_id: recipient.candidate_id,
    phone: recipient.phone,
    status: "FAILED",
    attempts: attempt,
    last_error: lastError,
  };
}

/**
 * Sends a bulk SMS batch. Every recipient's outcome (success or exhausted
 * retries) is written to `communication_log` and the audit trail — no
 * silent failures.
 */
export async function sendBulkSms(orgId: string, recipients: SmsRecipient[]): Promise<SmsSendResult[]> {
  const { apiKey, baseUrl } = await requireCredential(orgId, "sms_provider");
  const results: SmsSendResult[] = [];

  for (const recipient of recipients) {
    const result = await sendWithRetry(recipient, apiKey, baseUrl);
    results.push(result);

    await db.query(
      `INSERT INTO communication_log (candidate_id, channel, template_code, status)
       VALUES ($1,'SMS',$2,$3)`,
      [recipient.candidate_id, "BULK_SMS", result.status === "SENT" ? "SENT" : "FAILED"]
    );
  }

  const failedCount = results.filter((r) => r.status === "FAILED").length;
  await logAudit({
    entity_type: "COMMUNICATION",
    entity_id: `sms-batch-${Date.now()}`,
    agent_or_user: "SmsProviderConnector",
    action: "BULK_SMS_SENT",
    output_value: { total: results.length, failed: failedCount },
  });

  return results;
}
