/**
 * Communication dispatcher — the single transport path for outbound
 * messages and connector invocations.
 *
 * Responsibilities (all deterministic, all audited):
 * 1. Resolve the ordered provider chain for an org + message type
 *    (integration_fallback_configs; channel defaults when unconfigured).
 * 2. For each provider in order: rate-limit check → circuit-breaker
 *    check → retry-with-backoff → adapter send.
 * 3. Move to the next provider on: rate-limit rejection, open circuit,
 *    definitive failure (FAILED result). Stop on first success.
 * 4. Every attempt outcome lands in communication_log (registry path,
 *    including provider tracking columns) and the audit trail — no
 *    silent failures, ever.
 *
 * Legacy bridge: connectors `sms_provider`, `email`, `whatsapp_business`
 * predate the uniform registry and keep their own communication_log
 * writes; the dispatcher delegates to them and reports their outcome
 * without double-logging. New deployments should register fallback chains
 * using the uniform connector names (sms_teletalk, email_sendgrid, ...).
 */

import { getProvider, resolveConnectorName } from "../integrations/_base/registry";
import { requireCredential } from "../integrations/credential_store";
import {
  IntegrationResult,
  ProviderCredentialError,
  ProviderNotImplementedError,
} from "../integrations/_base/types";
import type { HttpProviderConfig } from "../integrations/sms/shared";
import { tryConsume as tryConsumeRateLimit } from "../integrations/_base/rate_limit";
import { allowRequest, recordFailure, recordSuccess } from "../integrations/_base/circuit_breaker";
import { withRetry } from "../integrations/_base/retry";
import { resolveFallbackChain } from "../integrations/_base/fallback";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { logger } from "../../utils/logger";
import * as legacySms from "../integrations/sms_provider";
import * as legacyEmail from "../integrations/email";
import * as legacyWhatsapp from "../integrations/whatsapp_business";

export type MessageType = "SMS" | "EMAIL" | "WHATSAPP";

/** Channel defaults used when the org has not configured a fallback chain. */
export const CHANNEL_DEFAULT_CHAINS: Record<MessageType, string[]> = {
  SMS: ["sms_provider"],
  EMAIL: ["email"],
  WHATSAPP: ["whatsapp_business"],
};

export interface DispatchOutcome {
  connector: string;
  status: "SENT" | "DELIVERED" | "FAILED";
  provider_message_id?: string;
  error_code?: string;
  error_message?: string;
  /** Which chain entry produced the outcome. */
  attempted_chain: string[];
}

export interface DispatchMeta {
  /** Candidate the message concerns (communication_log row + audit). */
  candidate_id?: string;
  /** Template code for the communication_log row. */
  template_code?: string;
  /** Actor attribution (user id or agent name). */
  actor: string;
}

/** Outcome of one provider attempt (pre-fallback). */
type AttemptOutcome =
  | { kind: "success"; provider_message_id?: string }
  | { kind: "definitive"; error_code: string; error_message: string }
  | { kind: "skipped"; error_code: "RATE_LIMITED" | "CIRCUIT_OPEN" | "MISSING_CREDENTIAL" | "NOT_IMPLEMENTED"; error_message: string }
  | { kind: "transient"; error_code: "TRANSIENT"; error_message: string };

const LEGACY_CONNECTORS = new Set(["sms_provider", "email", "whatsapp_business"]);

/** Sends one message through a registry adapter with retry applied. */
async function sendViaRegistry(
  orgId: string,
  connectorName: string,
  input: unknown,
  meta: DispatchMeta
): Promise<AttemptOutcome> {
  const mapping = resolveConnectorName(connectorName);
  if (!mapping) {
    return { kind: "definitive", error_code: "UNKNOWN_CONNECTOR", error_message: `Connector '${connectorName}' has no adapter mapping.` };
  }
  const adapter = getProvider(mapping.category, mapping.provider);
  if (!adapter) {
    return { kind: "definitive", error_code: "ADAPTER_NOT_REGISTERED", error_message: `Adapter '${mapping.category}:${mapping.provider}' is not registered.` };
  }

  let config: HttpProviderConfig;
  try {
    const cred = await requireCredential(orgId, connectorName as never);
    config = { apiKey: cred.apiKey, baseUrl: cred.baseUrl, orgId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ProviderCredentialError || (err instanceof Error && err.name === "MissingCredentialError")) {
      return { kind: "skipped", error_code: "MISSING_CREDENTIAL", error_message: message };
    }
    throw err;
  }

  if (!tryConsumeRateLimit(orgId, connectorName)) {
    return { kind: "skipped", error_code: "RATE_LIMITED", error_message: `Provider '${connectorName}' is rate limited for this org.` };
  }
  if (!allowRequest(orgId, connectorName)) {
    return { kind: "skipped", error_code: "CIRCUIT_OPEN", error_message: `Circuit breaker for '${connectorName}' is open.` };
  }

  try {
    const result: IntegrationResult<unknown> = await withRetry(
      () => adapter.send(input, config),
      undefined,
      undefined,
      `dispatch:${connectorName}`
    );
    if (result.status === "FAILED") {
      recordFailure(orgId, connectorName);
      return { kind: "definitive", error_code: result.error_code, error_message: result.error_message };
    }
    recordSuccess(orgId, connectorName);
    return { kind: "success", provider_message_id: result.provider_id };
  } catch (err) {
    if (err instanceof ProviderNotImplementedError) {
      return { kind: "skipped", error_code: "NOT_IMPLEMENTED", error_message: err.message };
    }
    recordFailure(orgId, connectorName);
    return {
      kind: "transient",
      error_code: "TRANSIENT",
      error_message: err instanceof Error ? err.message : String(err),
    };
  }
  // meta unused in the transport-only helper; candidate/template logging
  // happens in dispatchConnector where the communication_log row is written.
  void meta;
}

/** Sends one message through a legacy connector (own logging). */
async function sendViaLegacy(
  orgId: string,
  connectorName: string,
  input: { candidate_id: string | null; to: string; message: string },
  meta: DispatchMeta
): Promise<AttemptOutcome> {
  let cred: { apiKey: string; baseUrl: string | null };
  try {
    cred = await requireCredential(orgId, connectorName as never);
  } catch (err) {
    if (err instanceof Error && err.name === "MissingCredentialError") {
      return { kind: "skipped", error_code: "MISSING_CREDENTIAL", error_message: (err as Error).message };
    }
    throw err;
  }

  if (connectorName === "sms_provider") {
    const result = await legacySms.sendWithRetry(
      { candidate_id: input.candidate_id, phone: input.to, message: input.message },
      cred.apiKey,
      cred.baseUrl
    );
    // Legacy parity with email/whatsapp: the legacy SMS connector logs its
    // own communication_log row — sendWithRetry transports, it does not log.
    await db.query(
      `INSERT INTO communication_log (candidate_id, org_id, channel, template_code, status, error_message)
       VALUES ($1,$2,'SMS',$3,$4,$5)`,
      [
        input.candidate_id,
        orgId,
        meta.template_code ?? null,
        result.status,
        result.status === "FAILED" ? result.last_error ?? "SMS send failed after retries." : null,
      ]
    );
    return result.status === "SENT"
      ? { kind: "success" }
      : { kind: "definitive", error_code: "SMS_SEND_FAILED", error_message: result.last_error ?? "SMS send failed after retries." };
  }

  if (connectorName === "email") {
    const result = await legacyEmail.sendOutboundEmail(orgId, {
      candidate_id: input.candidate_id,
      to: input.to,
      subject: meta.template_code ?? "UROS notification",
      body_text: input.message,
      template_code: meta.template_code ?? "GENERIC",
    });
    return result.status === "SENT"
      ? { kind: "success" }
      : { kind: "definitive", error_code: "EMAIL_SEND_FAILED", error_message: result.last_error ?? "Email send failed." };
  }

  // whatsapp_business — the legacy template sender needs template params;
  // the dispatcher passes a single free-text body via the template's
  // documented single-parameter contract when a rendered body exists.
  const result = await legacyWhatsapp.sendTemplateMessage(orgId, {
    candidate_id: input.candidate_id,
    phone: input.to,
    template_name: meta.template_code ?? "generic",
    template_params: { body: input.message },
  });
  return result.status === "SENT"
    ? { kind: "success", provider_message_id: result.message_id }
    : { kind: "definitive", error_code: "WHATSAPP_SEND_FAILED", error_message: result.last_error ?? "WhatsApp send failed." };
}

/**
 * Dispatches one rendered message through the org's fallback chain.
 * Returns the outcome of the first provider that succeeded, or the last
 * definitive failure. Throws only on programming errors — delivery
 * failures are outcomes, not exceptions.
 */
export async function dispatchMessage(
  orgId: string,
  messageType: MessageType,
  input: { candidate_id: string | null; to: string; message: string },
  meta: DispatchMeta
): Promise<DispatchOutcome> {
  const configured = await resolveFallbackChain(orgId, messageType);
  const chain = configured.length > 0 ? configured : CHANNEL_DEFAULT_CHAINS[messageType];
  const attempted: string[] = [];

  let lastOutcome: AttemptOutcome = {
    kind: "definitive",
    error_code: "NO_PROVIDER_CONFIGURED",
    error_message: `No provider configured for ${messageType} in org ${orgId}.`,
  };

  for (const connectorName of chain) {
    attempted.push(connectorName);
    const isLegacy = LEGACY_CONNECTORS.has(connectorName);
    const outcome = isLegacy
      ? await sendViaLegacy(orgId, connectorName, input, meta)
      : await sendViaRegistry(orgId, connectorName, { to: input.to, message: input.message }, meta);

    if (outcome.kind === "success") {
      // Registry path writes its own communication_log row with provider
      // tracking; legacy connectors already logged their send.
      if (!isLegacy) {
        await db.query(
          `INSERT INTO communication_log (candidate_id, org_id, channel, template_code, status, provider_message_id, provider_name)
           VALUES ($1,$2,$3,$4,'SENT',$5,$6)`,
          [input.candidate_id, orgId, messageType, meta.template_code ?? null, outcome.provider_message_id ?? null, connectorName]
        );
      }
      await logAudit({
        org_id: orgId,
        entity_type: "COMMUNICATION",
        entity_id: input.candidate_id ?? orgId,
        agent_or_user: meta.actor,
        action: "MESSAGE_DISPATCHED",
        reason_code: "DISPATCH_SUCCESS",
        reason_comment: `Delivered via ${connectorName}.`,
        input_value: { channel: messageType, chain: attempted },
        output_value: { connector: connectorName, provider_message_id: outcome.provider_message_id ?? null },
      });
      return { connector: connectorName, status: "SENT", provider_message_id: outcome.provider_message_id, attempted_chain: attempted };
    }

    // Non-registry paths log their own rows; registry-path failures are
    // recorded here with the structured error.
    if (!isLegacy) {
      await db.query(
        `INSERT INTO communication_log (candidate_id, org_id, channel, template_code, status, error_code, error_message, provider_name)
         VALUES ($1,$2,$3,$4,'FAILED',$5,$6,$7)`,
        [input.candidate_id, orgId, messageType, meta.template_code ?? null, outcome.error_code, outcome.error_message, connectorName]
      );
    }
    logger.warn("DISPATCH_ATTEMPT_FAILED", {
      org_id: orgId,
      channel: messageType,
      connector: connectorName,
      error_code: outcome.error_code,
      error: outcome.error_message,
    });

    if (outcome.kind !== "skipped") {
      lastOutcome = outcome;
    } else {
      lastOutcome = { kind: "definitive", error_code: outcome.error_code, error_message: outcome.error_message };
    }
  }

  await logAudit({
    org_id: orgId,
    entity_type: "COMMUNICATION",
    entity_id: input.candidate_id ?? orgId,
    agent_or_user: meta.actor,
    action: "MESSAGE_DISPATCH_FAILED",
    reason_code: lastOutcome.error_code ?? "DISPATCH_FAILED",
    reason_comment: lastOutcome.error_message ?? "All providers in the fallback chain failed.",
    input_value: { channel: messageType, chain: attempted },
    output_value: { failed_connectors: attempted },
  });

  return {
    connector: attempted[attempted.length - 1] ?? "none",
    status: "FAILED",
    error_code: lastOutcome.error_code,
    error_message: lastOutcome.error_message,
    attempted_chain: attempted,
  };
}
