import { logAudit } from "../../utils/audit_helper";

export async function enqueueReview(candidateId: string, reason: string): Promise<void> {
  await logAudit({
    entity_type: "REVIEW_QUEUE",
    entity_id: candidateId,
    agent_or_user: "HILSupervisorAgent",
    action: "ENQUEUED_FOR_REVIEW",
    reason_code: reason,
  });
}

export async function buildReviewQueue(batchId: string): Promise<void> {
  await logAudit({
    entity_type: "BATCH",
    entity_id: batchId,
    agent_or_user: "HILSupervisorAgent",
    action: "REVIEW_QUEUE_BUILT",
  });
}
