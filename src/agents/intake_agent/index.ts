import { logAudit } from "../../utils/audit_helper";
import { RawApplicationDocument } from "../parser_agent";
import * as teletalk from "../../services/integrations/teletalk";

export interface Batch {
  batch_id: string;
  circular_id: string;
  org_id: string;
  source: { platform: string; preApprovedAutoIngest: boolean };
}

export async function fetchBatch(batchId: string, orgId: string): Promise<Batch> {
  // Stub — production: dispatch to connector under services/integrations/*
  // based on batch metadata persisted at import request time (see
  // POST /api/v1/applications/import).
  return {
    batch_id: batchId,
    circular_id: "STUB-CIRCULAR",
    org_id: orgId,
    source: { platform: "Teletalk", preApprovedAutoIngest: false },
  };
}

/**
 * Loads raw application documents for a batch, dispatching to the
 * connector matching the batch's source platform. Teletalk/bdjobs
 * returns already-structured records (no OCR needed); email/scanned
 * sources return documents that still need OCR downstream in
 * `parser_agent.extractFields`.
 */
export async function loadCandidates(batch: Batch): Promise<RawApplicationDocument[]> {
  let documents: RawApplicationDocument[] = [];

  if (batch.source.platform === "Teletalk") {
    const result = await teletalk.fetchApplicationsFromApi(batch.org_id, batch.circular_id);
    documents = result.applications.map((app) => ({
      type: "structured" as const,
      candidate_id: app.candidate_id,
      org_id: batch.org_id,
      full_name: app.full_name,
      phone_primary: app.phone_primary,
      email: app.email,
      job_circular_id: batch.circular_id,
      academic_cgpa: app.academic?.[0]?.cgpa,
      academic_division: app.academic?.[0]?.division_class,
    }));
  }
  // Other platforms (bdjobs, LinkedIn, email, CSV) are wired the same
  // way once their connectors are attached to a live batch source.

  await logAudit({
    entity_type: "BATCH",
    entity_id: batch.batch_id,
    agent_or_user: "IntakeAgent",
    action: "CANDIDATES_LOADED",
    output_value: { source: batch.source.platform, count: documents.length },
  });

  return documents;
}
