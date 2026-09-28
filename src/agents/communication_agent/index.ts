import { db } from "../../database/client";
import { Candidate } from "../../models/candidate.model";
import { logAudit } from "../../utils/audit_helper";
import { resolveTemplateLanguage } from "../../services/communication/template_language_resolver";

export type CommunicationChannel = "SMS" | "EMAIL" | "WHATSAPP";

/**
 * Sends a communication batch. For each recipient, deterministically
 * resolves which language variant of `templateCode` to use (Feature 5:
 * candidate.preferred_language → org.default_language → 'en'), logs the
 * resolved variant to `communication_log`, and writes a full
 * Global-Reasoning-Standard audit entry (reason_code + reason_description
 * + evidence) for the resolution itself — never a silent choice.
 */
export async function sendBatch(
  recipients: Candidate[],
  templateCode: string,
  channel: CommunicationChannel,
  orgId: string
): Promise<void> {
  const orgRes = await db.query<{ default_language: string }>(
    `SELECT default_language FROM organizations WHERE org_id=$1`,
    [orgId]
  );
  const orgDefaultLanguage = orgRes.rows[0]?.default_language ?? "en";

  for (const r of recipients) {
    const resolution = resolveTemplateLanguage(templateCode, r.preferred_language, orgDefaultLanguage);

    await db.query(
      `INSERT INTO communication_log (candidate_id, channel, template_code, status, language)
       VALUES ($1,$2,$3,'SENT',$4)`,
      [r.candidate_id, channel, resolution.resolved_template_code, resolution.language]
    );

    await logAudit({
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
  }
}
