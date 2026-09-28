import { db } from "../../database/client";

export type WebhookEventType =
  | "APPLICATION_BATCH_IMPORTED"
  | "EVALUATION_COMPLETED"
  | "HUMAN_OVERRIDE_MADE"
  | "VERIFICATION_COMPLETED"
  | "APPEAL_RESOLVED";

/**
 * Queues an outbound webhook for delivery (file 20 §5.6) into
 * `outgoing_webhook_deliveries`. Actual HTTP delivery and retry with
 * exponential backoff happen in `services/webhooks/scheduler.ts`, which
 * polls this table on an interval — this function only enqueues.
 */
export async function enqueueWebhookDelivery(
  orgId: string,
  eventType: WebhookEventType,
  targetUrl: string,
  payload: unknown
): Promise<string> {
  const res = await db.query<{ delivery_id: string }>(
    `INSERT INTO outgoing_webhook_deliveries (org_id, event_type, target_url, payload)
     VALUES ($1,$2,$3,$4)
     RETURNING delivery_id`,
    [orgId, eventType, targetUrl, JSON.stringify(payload)]
  );
  return res.rows[0].delivery_id;
}
