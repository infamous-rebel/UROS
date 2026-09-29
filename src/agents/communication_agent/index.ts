import { db } from "../../database/client";
import { Candidate } from "../../models/candidate.model";
import { logAudit } from "../../utils/audit_helper";
import { resolveTemplateLanguage } from "../../services/communication/template_language_resolver";
import { renderTemplateBody } from "../../services/communication/template_bodies";
import { dispatchMessage } from "../../services/communication/dispatcher";

export type CommunicationChannel = "SMS" | "EMAIL" | "WHATSAPP";

/**
 * Sends a communication batch over real transports.
 *
 * Per recipient, deterministically resolves which language variant of
 * `templateCode` to use (Feature 5: candidate.preferred_language →
 * org.default_language → 'en'), renders the authored template body,
 * and dispatches through the integration dispatcher (fallback chain →
 * rate limit → circuit breaker → retry → adapter). Every outcome —
 * success or structured failure — lands in communication_log and the
 * audit trail. A recipient with no contact channel for the selected
 * medium is recorded as FAILED with reason code CONTACT_CHANNEL_MISSING,
 * never silently skipped.
 */
export async function sendBatch(
  recipients: Candidate[],
  templateCode: string,
  channel: CommunicationChannel,
  orgId: string
): Promise<void> {
  const orgRes = await db.query<{ default_language: string; name: string }>(
    `SELECT default_language, name FROM organizations WHERE org_id=$1`,
    [orgId]
  );
  const orgDefaultLanguage = orgRes.rows[0]?.default_language ?? "en";
  const orgName = orgRes.rows[0]?.name ?? "";

  for (const r of recipients) {
    const resolution = resolveTemplateLanguage(templateCode, r.preferred_language, orgDefaultLanguage);

    await logAudit({
      org_id: orgId,
      entity_type: "COMMUNICATION",
      entity_id: r.candidate_id,
      agent_or_user: "CommunicationAgent",
      action: "TEMPLATE_LANGUAGE_RESOLVED",
      reason_code: resolution.reason_code,
      reason_comment: resolution.reason_description,
      input_value: {
        base_template_code: templateCode,
        channel,
        candidate_preferred_language: r.preferred_language ?? null,
        org_default_language: orgDefaultLanguage,
      },
      output_value: {
        resolved_template_code: resolution.resolved_template_code,
        language: resolution.language,
        fallback_applied: resolution.fallback_applied,
      },
    });

    const to = channel === "EMAIL" ? r.email : r.phone_primary;
    if (!to) {
      await db.query(
        `INSERT INTO communication_log (candidate_id, org_id, channel, template_code, status, error_code, error_message)
         VALUES ($1,$2,$3,$4,'FAILED','CONTACT_CHANNEL_MISSING',$5)`,
        [r.candidate_id, orgId, channel, resolution.resolved_template_code, `Candidate has no ${channel === "EMAIL" ? "email address" : "phone number"} on file.`]
      );
      await logAudit({
        org_id: orgId,
        entity_type: "COMMUNICATION",
        entity_id: r.candidate_id,
        agent_or_user: "CommunicationAgent",
        action: "MESSAGE_DISPATCH_FAILED",
        reason_code: "CONTACT_CHANNEL_MISSING",
        reason_comment: `No ${channel === "EMAIL" ? "email" : "phone"} on file for candidate.`,
        output_value: { channel, template_code: resolution.resolved_template_code },
      });
      continue;
    }

    const body = renderTemplateBody(templateCode, resolution.language, {
      candidate_name: r.full_name,
      candidate_id: r.candidate_id,
      org_name: orgName,
      position: r.position_applied ?? r.job_circular_id ?? "the advertised position",
    });

    // Transport + communication_log + dispatch audit happen inside the
    // dispatcher (fallback chain, rate limit, circuit breaker, retry).
    await dispatchMessage(
      orgId,
      channel,
      { candidate_id: r.candidate_id, to, message: body },
      {
        candidate_id: r.candidate_id,
        template_code: resolution.resolved_template_code,
        actor: "CommunicationAgent",
      }
    );
  }
}
