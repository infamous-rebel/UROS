/**
 * Search routes — Quest 05 Part 2 CommandBar global search (Cmd+K).
 *
 * GET /?q= — org-scoped ILIKE search across candidates, rule_packs,
 * gates, and audit_log. Returns grouped results with up to 5 items per
 * category. Minimum query length: 2 characters.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";

const router = Router();

const QuerySchema = z.object({
  q: z.string().min(2).max(100),
});

interface SearchResult {
  id: string;
  title: string;
  subtitle: string;
  category: "candidate" | "rule" | "gate" | "audit";
}

/**
 * GET /api/v1/search?q= — Quest 05 Part 2 "Global search".
 * Searches candidates, rule_packs, gates, and audit_log scoped to the
 * caller's org. Returns grouped results for keyboard-navigable display.
 */
router.get(
  "/",
  authenticate,
  rbac("RECRUITER", "SENIOR_RECRUITER", "ADMIN", "DEPT_HEAD", "AUDITOR"),
  validate({ query: QuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.user!.org_id;
      const q = (req.query as z.infer<typeof QuerySchema>).q;
      const pattern = `%${q}%`;

      // Candidates: name, email, phone, candidate_id.
      const candidates = await db.query<{
        candidate_id: string;
        full_name: string;
        email: string | null;
        status: string;
      }>(
        `SELECT candidate_id, full_name, email, status
         FROM candidates
         WHERE org_id = $1
           AND (full_name ILIKE $2 OR email ILIKE $2 OR phone_primary ILIKE $2 OR candidate_id ILIKE $2)
         ORDER BY updated_at DESC
         LIMIT 5`,
        [orgId, pattern]
      );

      // Rule packs: name.
      const rules = await db.query<{
        rule_pack_id: string;
        name: string;
        sector: string;
      }>(
        `SELECT rule_pack_id, name, sector
         FROM rule_packs
         WHERE org_id = $1 AND name ILIKE $2
         ORDER BY created_at DESC
         LIMIT 5`,
        [orgId, pattern]
      );

      // Gates: batch_id, gate_type (PENDING only).
      const gates = await db.query<{
        gate_id: string;
        batch_id: string;
        gate_type: string;
      }>(
        `SELECT gate_id, batch_id, gate_type
         FROM gate_events
         WHERE org_id = $1 AND status = 'PENDING' AND (batch_id ILIKE $2 OR gate_type ILIKE $2)
         ORDER BY created_at DESC
         LIMIT 5`,
        [orgId, pattern]
      );

      // Audit log: action text, scoped via org_id column (added in 0030).
      const audits = await db.query<{
        audit_id: string;
        action: string;
        entity_type: string;
        entity_id: string;
      }>(
        `SELECT audit_id::text AS audit_id, action, entity_type, entity_id
         FROM audit_log
         WHERE org_id = $1 AND action ILIKE $2
         ORDER BY timestamp DESC
         LIMIT 5`,
        [orgId, pattern]
      );

      const results: SearchResult[] = [
        ...candidates.rows.map((r) => ({
          id: r.candidate_id,
          title: r.full_name,
          subtitle: r.email ?? r.status,
          category: "candidate" as const,
        })),
        ...rules.rows.map((r) => ({
          id: r.rule_pack_id,
          title: r.name,
          subtitle: r.sector,
          category: "rule" as const,
        })),
        ...gates.rows.map((r) => ({
          id: r.gate_id,
          title: r.gate_type,
          subtitle: r.batch_id,
          category: "gate" as const,
        })),
        ...audits.rows.map((r) => ({
          id: r.audit_id,
          title: r.action,
          subtitle: `${r.entity_type}:${r.entity_id}`,
          category: "audit" as const,
        })),
      ];

      res.status(200).json({ results });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
