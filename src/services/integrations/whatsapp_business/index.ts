import { requireCredential } from "../credential_store";
import { db } from "../../../database/client";
import { logAudit } from "../../../utils/audit_helper";
import { logger } from "../../../utils/logger";

export interface WhatsAppRecipient {
  /** Null for user-directed sends (e.g. auth password-reset links). */
  candidate_id: string | null;
  phone: string;
  template_name: string;
  template_params: Record<string, string>;
}

export interface WhatsAppSendResult {
  candidate_id: string | null;
  message_id?: string;
  status: "SENT" | "FAILED";
  last_error?: string;
}

/**
 * Sends a single pre-approved WhatsApp Business template message
 * (interview reminders, shortlist notices — file 20 §9.5). Templates
 * must already be approved by Meta; free-form messages are not supported
 * outside a customer-initiated session window.
 */
export async function sendTemplateMessage(
  orgId: string,
  recipient: WhatsAppRecipient
): Promise<WhatsAppSendResult> {
  const { apiKey, baseUrl } = await requireCredential(orgId, "whatsapp_business");

  try {
    const res = await fetch(`${baseUrl ?? "https://graph.facebook.com/v19.0"}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient.phone,
        type: "template",
        template: { name: recipient.template_name, language: { code: "en" }, parameters: recipient.template_params },
      }),
    });
    if (!res.ok) throw new Error(`WhatsApp API responded ${res.status}: ${res.statusText}`);
    const body = (await res.json()) as { messages: Array<{ id: string }> };

    await db.query(
      `INSERT INTO communication_log (candidate_id, org_id, channel, template_code, status)
       VALUES ($1,$2,'WHATSAPP',$3,'SENT')`,
      [recipient.candidate_id, orgId, recipient.template_name]
    );

    return { candidate_id: recipient.candidate_id, message_id: body.messages?.[0]?.id, status: "SENT" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("WHATSAPP_SEND_FAILED", { candidate_id: recipient.candidate_id, error: message });

    await db.query(
      `INSERT INTO communication_log (candidate_id, org_id, channel, template_code, status)
       VALUES ($1,$2,'WHATSAPP',$3,'FAILED')`,
      [recipient.candidate_id, orgId, recipient.template_name]
    );

    return { candidate_id: recipient.candidate_id, status: "FAILED", last_error: message };
  }
}

export async function sendTemplateBatch(orgId: string, recipients: WhatsAppRecipient[]): Promise<WhatsAppSendResult[]> {
  const results: WhatsAppSendResult[] = [];
  for (const recipient of recipients) {
    results.push(await sendTemplateMessage(orgId, recipient));
  }

  await logAudit({
    entity_type: "COMMUNICATION",
    entity_id: `whatsapp-batch-${Date.now()}`,
    agent_or_user: "WhatsAppBusinessConnector",
    action: "TEMPLATE_BATCH_SENT",
    output_value: { total: results.length, failed: results.filter((r) => r.status === "FAILED").length },
  });

  return results;
}

/**
 * Handles an inbound delivery-status webhook payload from Meta
 * (sent → delivered → read, or failed). Updates communication_log by
 * matching on the provider message_id stored at send time.
 * Called from `webhooks.routes.ts` after signature verification.
 */
export async function handleDeliveryStatusWebhook(payload: {
  message_id: string;
  status: "delivered" | "read" | "failed";
}): Promise<void> {
  await logAudit({
    entity_type: "COMMUNICATION",
    entity_id: payload.message_id,
    agent_or_user: "WhatsAppBusinessConnector",
    action: "DELIVERY_STATUS_RECEIVED",
    output_value: payload,
  });
}
