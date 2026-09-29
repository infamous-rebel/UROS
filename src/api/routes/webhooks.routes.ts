import { Router, Request, Response, NextFunction } from "express";
import express from "express";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { verifyWebhookSignature } from "../../services/webhooks/signature";
import { handleDeliveryStatusWebhook } from "../../services/integrations/whatsapp_business";
import { getCredential } from "../../services/integrations/credential_store";
import { logger } from "../../utils/logger";

const router = Router();

const SUPPORTED_CONNECTORS = new Set([
  "teletalk", "bdjobs", "linkedin", "email", "sms_provider", "whatsapp_business", "calendar",
]);

/**
 * POST /api/v1/webhooks/:connector
 *
 * Receives inbound events from external platforms (delivery status
 * callbacks, application notifications, etc). Every payload is logged to
 * `inbound_webhook_events` regardless of signature outcome, for audit —
 * an invalid signature is itself a security-relevant event worth keeping.
 *
 * Uses express.raw() (not express.json()) for this route specifically so
 * the exact bytes are available for HMAC verification before parsing.
 */
router.post(
  "/:connector",
  express.raw({ type: "*/*", limit: "2mb" }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const connector = req.params.connector;
      if (!SUPPORTED_CONNECTORS.has(connector)) {
        res.status(404).json({ error: "Unknown connector" });
        return;
      }

      const orgId = (req.query.org_id as string | undefined) ?? undefined;
      const signatureHeader = req.headers["x-uros-signature"] as string | undefined;
      const rawBody = req.body as Buffer; // Buffer, thanks to express.raw()

      let signatureValid = false;
      if (orgId) {
        // Webhook secrets are stored the same way as connector API keys (BYOK),
        // under a dedicated "webhook_secret" label per connector.
        const secretCred = await getCredential(orgId, connector as any, "webhook_secret");
        if (secretCred) {
          signatureValid = verifyWebhookSignature(rawBody, signatureHeader, secretCred.apiKey);
        }
      }

      let parsedPayload: unknown = null;
      try {
        parsedPayload = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : null;
      } catch {
        parsedPayload = { raw: rawBody.toString("utf8") };
      }

      const eventRes = await db.query<{ event_id: string }>(
        `INSERT INTO inbound_webhook_events (org_id, connector, signature_valid, headers, payload)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING event_id`,
        [orgId ?? null, connector, signatureValid, JSON.stringify(req.headers), JSON.stringify(parsedPayload)]
      );
      const eventId = eventRes.rows[0].event_id;

      await logAudit({
        entity_type: "WEBHOOK_INBOUND",
        entity_id: eventId,
        agent_or_user: `${connector}Webhook`,
        action: "WEBHOOK_RECEIVED",
        reason_code: signatureValid ? "SIGNATURE_VALID" : "SIGNATURE_INVALID_OR_UNVERIFIABLE",
        output_value: { connector, org_id: orgId },
      });

      if (!signatureValid) {
        res.status(401).json({ error: "Invalid or missing webhook signature", event_id: eventId });
        return;
      }

      try {
        await routeToHandler(connector, parsedPayload, orgId);
        await db.query(`UPDATE inbound_webhook_events SET processed=true WHERE event_id=$1`, [eventId]);
      } catch (handlerErr) {
        const message = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
        await db.query(
          `UPDATE inbound_webhook_events SET processed=false, processing_error=$1 WHERE event_id=$2`,
          [message, eventId]
        );
        logger.error("WEBHOOK_HANDLER_FAILED", { connector, eventId, error: message });
      }

      res.status(200).json({ status: "RECEIVED", event_id: eventId });
    } catch (err) {
      next(err);
    }
  }
);

async function routeToHandler(connector: string, payload: unknown, orgId?: string): Promise<void> {
  switch (connector) {
    case "whatsapp_business":
      // Meta's actual payload shape is nested; production code should
      // extract {message_id, status} from `entry[0].changes[0].value.statuses[0]`.
      if (isDeliveryStatusPayload(payload)) {
        await handleDeliveryStatusWebhook(payload);
      }
      return;
    case "sms_provider":
    case "teletalk":
    case "linkedin":
    case "email":
    case "calendar":
      // No specific handling wired yet for these connectors' inbound
      // events in this reference implementation — logged above regardless.
      return;
    case "bdjobs":
      await handleBdjobsWebhook(payload, orgId);
      return;
    default:
      return;
  }
}

/**
 * Handle a Bdjobs ATS webhook payload — extract applicant data and
 * create candidate records.
 */
async function handleBdjobsWebhook(payload: unknown, orgId: string | undefined): Promise<void> {
  if (!orgId || typeof payload !== "object" || payload === null) return;
  const p = payload as Record<string, unknown>;

  // Expected payload: { applicant: { name, email, phone, circular_id } }
  const applicant = (p.applicant ?? p) as Record<string, unknown>;
  const name = String(applicant.name ?? "Bdjobs Webhook Applicant");
  const email = applicant.email ? String(applicant.email) : null;
  const phone = applicant.phone ? String(applicant.phone) : null;
  const circularId = applicant.circular_id ? String(applicant.circular_id) : `bdjobs-wh-${Date.now()}`;

  const candidateId = `BDJWH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await db.query(
    `INSERT INTO candidates (candidate_id, org_id, full_name, email, phone_primary, source_platform, job_circular_id, status)
     VALUES ($1,$2,$3,$4,$5,'bdjobs',$6,'INTAKE')`,
    [candidateId, orgId, name, email, phone, circularId]
  );

  await logAudit({
    org_id: orgId,
    entity_type: "CANDIDATE",
    entity_id: candidateId,
    agent_or_user: "bdjobsWebhook",
    action: "BDJOBS_WEBHOOK_CANDIDATE_CREATED",
    output_value: { name, email, circular_id: circularId },
  });
}

function isDeliveryStatusPayload(
  payload: unknown
): payload is { message_id: string; status: "delivered" | "read" | "failed" } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "message_id" in payload &&
    "status" in payload
  );
}

export default router;
