import { requireCredential } from "../credential_store";
import { db } from "../../../database/client";
import { logAudit } from "../../../utils/audit_helper";
import { logger } from "../../../utils/logger";

export interface EmailAttachment {
  filename: string;
  mime_type: string;
  buffer: Buffer;
}

export interface IncomingApplicationEmail {
  message_id: string;
  from: string;
  subject: string;
  received_at: string;
  attachments: EmailAttachment[];
}

/**
 * Fetches unread application emails with PDF/Word attachments (file 02 §2,
 * "Email and WhatsApp" — common in SME/NGO recruitment).
 *
 * Assumption (stated once): a live IMAP/Gmail API client (e.g. `imapflow`
 * or the Gmail REST API) is not wired in this reference implementation —
 * connecting requires a real mailbox and BYOK-provided app password/OAuth
 * token. The function signature and downstream contract (attachments as
 * Buffers handed to `parser_agent.extractFields`) are final; only the
 * fetch transport itself needs to be swapped in for a live deployment.
 */
export async function fetchUnreadApplicationEmails(
  orgId: string,
  circularId: string
): Promise<IncomingApplicationEmail[]> {
  // Confirms credentials are configured before attempting connection,
  // so a misconfigured org fails fast with a clear BYOK error.
  await requireCredential(orgId, "email");

  throw new Error(
    `Not implemented: IMAP/Gmail transport for circular ${circularId}. Wire an IMAP ` +
      "client (e.g. imapflow) or Gmail API here using the org's BYOK 'email' credential; " +
      "return IncomingApplicationEmail[] with attachment buffers per this module's contract. " +
      "On success, callers must log an INTEGRATION/APPLICATION_EMAILS_FETCHED audit entry."
  );
}

export interface OutboundEmailRecipient {
  /** Null for user-directed sends (e.g. auth password-reset links). */
  candidate_id: string | null;
  to: string;
  subject: string;
  body_text: string;
  template_code: string;
}

export interface OutboundEmailResult {
  candidate_id: string | null;
  status: "SENT" | "FAILED";
  last_error?: string;
}

/**
 * Sends a single transactional email via the org's BYOK 'email' credential
 * (base_url points at whatever transactional email API the org has
 * configured — e.g. SES, SendGrid, Postmark — all of which expose an
 * equivalent "POST /send with Bearer auth + JSON {to,subject,body}"
 * shape once fronted by the org's own relay; orgs with a different
 * provider contract configure base_url to point at their own adapter).
 * Mirrors sms_provider.sendWithRetry / whatsapp_business.sendTemplateMessage:
 * a real network call, deterministic SENT/FAILED outcome, every outcome
 * written to communication_log, never a silent failure.
 *
 * Added for Feature 7 (Automated Reference Checking), which is the first
 * feature to need an *outbound* email send — the module previously only
 * covered inbound application-intake fetch.
 */
export async function sendOutboundEmail(orgId: string, recipient: OutboundEmailRecipient): Promise<OutboundEmailResult> {
  const { apiKey, baseUrl } = await requireCredential(orgId, "email");

  try {
    const res = await fetch(`${baseUrl ?? "https://api.email-provider.example/v1"}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: recipient.to, subject: recipient.subject, text: recipient.body_text }),
    });
    if (!res.ok) throw new Error(`Email API responded ${res.status}: ${res.statusText}`);

    await db.query(
      `INSERT INTO communication_log (candidate_id, org_id, channel, template_code, status)
       VALUES ($1,$2,'EMAIL',$3,'SENT')`,
      [recipient.candidate_id, orgId, recipient.template_code]
    );

    return { candidate_id: recipient.candidate_id, status: "SENT" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("EMAIL_SEND_FAILED", { candidate_id: recipient.candidate_id, error: message });

    await db.query(
      `INSERT INTO communication_log (candidate_id, org_id, channel, template_code, status)
       VALUES ($1,$2,'EMAIL',$3,'FAILED')`,
      [recipient.candidate_id, orgId, recipient.template_code]
    );

    await logAudit({
      org_id: orgId,
      entity_type: "COMMUNICATION",
      entity_id: recipient.candidate_id ?? orgId,
      agent_or_user: "EmailConnector",
      action: "EMAIL_SEND_FAILED",
      output_value: { template_code: recipient.template_code },
      reason_code: "EMAIL_SEND_ERROR",
      reason_comment: message,
    });

    return { candidate_id: recipient.candidate_id, status: "FAILED", last_error: message };
  }
}

/** Filters attachments to only CV-like document types before OCR/parsing. */
export function filterCvAttachments(attachments: EmailAttachment[]): EmailAttachment[] {
  const allowed = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]);
  return attachments.filter((a) => allowed.has(a.mime_type));
}
