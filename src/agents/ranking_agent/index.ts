import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { logger } from "../../utils/logger";

interface ScoredCandidate {
  candidate_id: string;
  scoring_id: string;
  total_score: number;
  phone_primary: string | null;
  national_id: string | null;
  duplicate_of: string | null;
}

/**
 * Deduplicates and ranks candidates within a specific org + circular scope.
 *
 * Quest 01 rewrite:
 *  - Signature: (batchId, orgId) — scoped to the batch's org + circular.
 *  - Selects candidates by org_id + job_circular_id from the batch.
 *  - Dedupes within org + circular only (no cross-circular leakage).
 *  - Replaces N sequential UPDATEs with a single bulk UPDATE ... FROM (VALUES...).
 *  - Idempotent: re-running yields the same ranking (ON CONFLICT-safe dedup marking,
 *    deterministic rank assignment overwrites previous values to the same result).
 */
export async function rankAndDedupe(batchId: string, orgId: string): Promise<void> {
  // Resolve the circular for this batch from the candidates themselves.
  const circularRes = await db.query<{ job_circular_id: string }>(
    `SELECT DISTINCT c.job_circular_id
     FROM candidates c
     JOIN scoring_results sr ON sr.candidate_id = c.candidate_id
     WHERE c.org_id = $1
       AND c.status IN ('SCORED', 'ELIGIBILITY_DONE')
     LIMIT 1`,
    [orgId]
  );

  if (circularRes.rowCount === 0) {
    logger.info("RANKING_NO_SCORED_CANDIDATES", { batchId, orgId });
    return;
  }

  const circularId = circularRes.rows[0].job_circular_id;

  // Fetch all scored candidates for this org + circular.
  const rows = await db.query<ScoredCandidate>(
    `SELECT c.candidate_id, sr.scoring_id, sr.total_score,
            c.phone_primary, c.national_id, c.duplicate_of
     FROM candidates c
     JOIN scoring_results sr ON sr.candidate_id = c.candidate_id
     WHERE c.org_id = $1
       AND c.job_circular_id = $2
       AND c.status IN ('SCORED', 'ELIGIBILITY_DONE')
     ORDER BY sr.total_score DESC, c.application_date ASC NULLS LAST, c.candidate_id ASC`,
    [orgId, circularId]
  );

  if (rows.rowCount === 0) {
    logger.info("RANKING_NO_SCORED_CANDIDATES", { batchId, orgId, circularId });
    return;
  }

  // --- Deduplication ---
  const groups = new Map<string, ScoredCandidate[]>();
  const ungrouped: ScoredCandidate[] = [];

  for (const row of rows.rows) {
    const key = row.national_id || row.phone_primary;
    if (!key) {
      ungrouped.push(row);
      continue;
    }
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const survivors: ScoredCandidate[] = [...ungrouped];
  const duplicateIds: string[] = [];
  const winnerMap = new Map<string, string>(); // loser_id -> winner_id

  for (const group of groups.values()) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }
    // Rows already ordered by score DESC / date ASC / id ASC from the query,
    // so group[0] is deterministically the winner.
    const [winner, ...losers] = group;
    survivors.push(winner);

    for (const loser of losers) {
      // Idempotent: only update if not already marked as duplicate of the same winner.
      if (loser.duplicate_of !== winner.candidate_id) {
        duplicateIds.push(loser.candidate_id);
        winnerMap.set(loser.candidate_id, winner.candidate_id);
      }
    }
  }

  // Bulk-mark duplicates in a single UPDATE (instead of N sequential ones).
  if (duplicateIds.length > 0) {
    const valuesClauses = duplicateIds.map((_, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::uuid)`).join(", ");
    const params: string[] = [];
    for (const id of duplicateIds) {
      params.push(id, winnerMap.get(id)!);
    }

    await db.query(
      `UPDATE candidates
       SET status = 'WITHDRAWN', duplicate_of = t.winner_id, updated_at = now()
       FROM (VALUES ${valuesClauses}) AS t(candidate_id, winner_id)
       WHERE candidates.candidate_id = t.candidate_id::uuid`,
      params
    );

    for (const loserId of duplicateIds) {
      await logAudit({
        entity_type: "CANDIDATE",
        entity_id: loserId,
        agent_or_user: "RankingAgent",
        action: "MARKED_DUPLICATE",
        reason_code: "DUPLICATE_APPLICATION",
        output_value: { kept_candidate_id: winnerMap.get(loserId) },
      });
    }
  }

  // --- Ranking ---
  // Deterministic final ordering, matching the query's own tie-break rule.
  survivors.sort((a, b) => {
    if (b.total_score !== a.total_score) return b.total_score - a.total_score;
    return a.candidate_id.localeCompare(b.candidate_id);
  });

  // Bulk rank update: single UPDATE ... FROM (VALUES ...) instead of N sequential UPDATEs.
  if (survivors.length > 0) {
    const rankValues = survivors.map((_, i) => `('${survivors[i].scoring_id}', ${i + 1})`).join(", ");

    await db.query(
      `UPDATE scoring_results
       SET rank = t.rank
       FROM (VALUES ${rankValues}) AS t(scoring_id, rank)
       WHERE scoring_results.scoring_id = t.scoring_id::uuid`
    );
  }

  await logAudit({
    entity_type: "BATCH",
    entity_id: batchId,
    agent_or_user: "RankingAgent",
    action: "RANKING_COMPLETED",
    output_value: {
      org_id: orgId,
      circular_id: circularId,
      ranked: survivors.length,
      duplicates_marked: duplicateIds.length,
    },
  });
}
