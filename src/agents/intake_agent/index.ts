import { logAudit } from "../../utils/audit_helper";
import { db } from "../../database/client";
import { RawApplicationDocument } from "../parser_agent";
import * as teletalk from "../../services/integrations/teletalk";

export interface Batch {
  batch_id: string;
  circular_id: string;
  org_id: string;
  source: { platform: string; preApprovedAutoIngest: boolean };
}

/**
 * Loads batch metadata persisted at import/pull request time
 * (import_batches, migration 0033). Throws a structured error for an
 * unknown batch — never a synthetic marker.
 */
export async function fetchBatch(batchId: string, orgId: string): Promise<Batch> {
  const res = await db.query<{
    batch_id: string;
    org_id: string;
    circular_id: string;
    source: string;
  }>(
    `SELECT batch_id, org_id, circular_id, source FROM import_batches
     WHERE batch_id = $1 AND org_id = $2`,
    [batchId, orgId]
  );
  if (res.rowCount === 0) {
    throw new Error(`Import batch not found: ${batchId} for org ${orgId}`);
  }
  const row = res.rows[0];
  return {
    batch_id: row.batch_id,
    circular_id: row.circular_id,
    org_id: row.org_id,
    source: {
      platform: row.source,
      // Teletalk applications are pre-approved structured feeds; every
      // other source requires the normal screening pipeline.
      preApprovedAutoIngest: row.source === "Teletalk",
    },
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
