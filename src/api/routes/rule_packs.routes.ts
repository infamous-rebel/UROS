/**
 * Quest 05 Part 6 — Brain Studio: Rule pack management, simulation, publish.
 *
 * Endpoints:
 *   GET    /rule-packs              — list org's rule packs with version counts
 *   POST   /rule-packs              — create a new rule pack
 *   GET    /rule-packs/:id          — get pack with versions, rules, affected counts
 *   POST   /rule-packs/:id/versions — create a new version (draft)
 *   POST   /rule-packs/:id/publish  — activate a version (deactivates prior)
 *   POST   /rule-packs/:id/simulate — evaluate rules against sample candidate data
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { checkRuleConflicts } from "../../rules/engine/conflict_checker";
import { applyOperator } from "../../rules/engine/operators";
import { Rule } from "../../models/rule.model";

const router = Router();

const CreatePackSchema = z.object({
  name: z.string().min(1).max(200),
  sector: z.string().min(1).default("GOVT_NONCADRE"),
  circular_id: z.string().nullable().optional(),
});

const CreateVersionSchema = z.object({
  change_summary: z.string().min(1),
});

const PublishSchema = z.object({
  version_id: z.string().uuid(),
});

const SimulateSchema = z.object({
  version_id: z.string().uuid().optional(),
  candidates: z.array(z.record(z.unknown())).min(1).max(100),
});

// ─── List Rule Packs ─────────────────────────────────────────────────

router.get(
  "/",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER", "AUDITOR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const packs = await db.query(
        `SELECT rp.*, 
                (SELECT COUNT(*) FROM rule_pack_versions v WHERE v.rule_pack_id = rp.rule_pack_id) AS version_count,
                (SELECT v2.version_number FROM rule_pack_versions v2 
                 WHERE v2.rule_pack_id = rp.rule_pack_id 
                 ORDER BY v2.version_number DESC LIMIT 1) AS latest_version
         FROM rule_packs rp
         WHERE rp.org_id = $1
         ORDER BY rp.created_at DESC`,
        [req.user!.org_id]
      );
      res.status(200).json({ rule_packs: packs.rows, count: packs.rowCount });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Create Rule Pack ────────────────────────────────────────────────

router.post(
  "/",
  authenticate,
  rbac("ADMIN"),
  validate({ body: CreatePackSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, sector, circular_id } = req.body as z.infer<typeof CreatePackSchema>;

      const packRes = await db.query(
        `INSERT INTO rule_packs (org_id, name, sector, circular_id, is_active, created_by)
         VALUES ($1, $2, $3, $4, true, $5)
         RETURNING *`,
        [req.user!.org_id, name, sector, circular_id ?? null, req.user!.user_id]
      );
      const pack = packRes.rows[0];

      // Create initial version (v1)
      const versionRes = await db.query(
        `INSERT INTO rule_pack_versions (rule_pack_id, version_number, change_summary, created_by)
         VALUES ($1, 1, 'Initial version', $2)
         RETURNING *`,
        [pack.rule_pack_id, req.user!.user_id]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "RULE_PACK",
        entity_id: pack.rule_pack_id,
        agent_or_user: req.user!.user_id,
        action: "RULE_PACK_CREATED",
        output_value: { name, sector, version_id: versionRes.rows[0].version_id },
      });

      res.status(201).json({ rule_pack: pack, initial_version: versionRes.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Get Rule Pack Detail ────────────────────────────────────────────

router.get(
  "/:id",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER", "AUDITOR"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const packRes = await db.query(
        `SELECT rp.* FROM rule_packs rp WHERE rp.rule_pack_id = $1 AND rp.org_id = $2`,
        [id, req.user!.org_id]
      );
      if (packRes.rowCount === 0) {
        res.status(404).json({ error: "Rule pack not found" });
        return;
      }

      const versionsRes = await db.query(
        `SELECT v.*, 
                (SELECT COUNT(*) FROM rules r WHERE r.rule_pack_version_id = v.version_id AND r.active = true) AS rule_count
         FROM rule_pack_versions v
         WHERE v.rule_pack_id = $1
         ORDER BY v.version_number DESC`,
        [id]
      );

      // Get rules for the latest version
      const latestVersionId = versionsRes.rows[0]?.version_id;
      let rules: any[] = [];
      const affectedCounts: Record<string, number> = {};

      if (latestVersionId) {
        const rulesRes = await db.query(
          `SELECT * FROM rules WHERE rule_pack_version_id = $1 ORDER BY created_at ASC`,
          [latestVersionId]
        );
        rules = rulesRes.rows;

        // Get affected candidate counts per rule
        const countsRes = await db.query(
          `SELECT rule_id, COUNT(*) AS affected_count
           FROM evaluation_results
           WHERE rule_pack_version_id = $1 AND org_id = $2
           GROUP BY rule_id`,
          [latestVersionId, req.user!.org_id]
        );
        for (const row of countsRes.rows) {
          affectedCounts[row.rule_id] = Number(row.affected_count);
        }
      }

      res.status(200).json({
        rule_pack: packRes.rows[0],
        versions: versionsRes.rows,
        rules,
        affected_counts: affectedCounts,
        latest_version_id: latestVersionId ?? null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Create New Version ──────────────────────────────────────────────

router.post(
  "/:id/versions",
  authenticate,
  rbac("ADMIN"),
  validate({ body: CreateVersionSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { change_summary } = req.body as z.infer<typeof CreateVersionSchema>;

      const packRes = await db.query(
        `SELECT * FROM rule_packs WHERE rule_pack_id = $1 AND org_id = $2`,
        [id, req.user!.org_id]
      );
      if (packRes.rowCount === 0) {
        res.status(404).json({ error: "Rule pack not found" });
        return;
      }

      // Get next version number
      const maxRes = await db.query(
        `SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM rule_pack_versions WHERE rule_pack_id = $1`,
        [id]
      );
      const nextVersion = Number(maxRes.rows[0].max_ver) + 1;

      // Copy rules from the latest version to the new one
      const latestRes = await db.query(
        `SELECT version_id FROM rule_pack_versions WHERE rule_pack_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [id]
      );
      const latestVersionId = latestRes.rows[0]?.version_id;

      const versionRes = await db.query(
        `INSERT INTO rule_pack_versions (rule_pack_id, version_number, change_summary, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, nextVersion, change_summary, req.user!.user_id]
      );
      const newVersion = versionRes.rows[0];

      // Copy rules from latest version
      if (latestVersionId) {
        await db.query(
          `INSERT INTO rules (rule_pack_version_id, rule_code, rule_type, field_path, operator,
                              threshold_type, threshold_value, review_margin, min_confidence_threshold,
                              fail_reason_code, is_knockout, weight)
           SELECT $1, rule_code, rule_type, field_path, operator,
                  threshold_type, threshold_value, review_margin, min_confidence_threshold,
                  fail_reason_code, is_knockout, weight
           FROM rules WHERE rule_pack_version_id = $2 AND active = true`,
          [newVersion.version_id, latestVersionId]
        );
      }

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "RULE_PACK",
        entity_id: id,
        agent_or_user: req.user!.user_id,
        action: "RULE_VERSION_CREATED",
        output_value: { version_number: nextVersion, change_summary },
      });

      res.status(201).json({ version: newVersion });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Check Conflicts (without publishing) ────────────────────────────

router.get(
  "/:id/conflicts",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const versionId = (req.query.version_id as string) ?? null;

      let targetVersionId = versionId;
      if (!targetVersionId) {
        const latestRes = await db.query(
          `SELECT version_id FROM rule_pack_versions WHERE rule_pack_id = $1 ORDER BY version_number DESC LIMIT 1`,
          [id]
        );
        targetVersionId = latestRes.rows[0]?.version_id ?? null;
      }
      if (!targetVersionId) {
        res.status(404).json({ error: "No versions found for this rule pack" });
        return;
      }

      const rulesRes = await db.query<Rule>(
        `SELECT * FROM rules WHERE rule_pack_version_id = $1 AND active = true`,
        [targetVersionId]
      );
      const conflicts = checkRuleConflicts(rulesRes.rows);

      res.status(200).json({
        version_id: targetVersionId,
        rule_count: rulesRes.rowCount,
        conflicts,
        clean: conflicts.length === 0,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Publish (Activate) Version ──────────────────────────────────────

router.post(
  "/:id/publish",
  authenticate,
  rbac("ADMIN"),
  validate({ body: PublishSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { version_id } = req.body as z.infer<typeof PublishSchema>;

      const packRes = await db.query(
        `SELECT * FROM rule_packs WHERE rule_pack_id = $1 AND org_id = $2`,
        [id, req.user!.org_id]
      );
      if (packRes.rowCount === 0) {
        res.status(404).json({ error: "Rule pack not found" });
        return;
      }

      // Verify version belongs to this pack
      const versionRes = await db.query(
        `SELECT * FROM rule_pack_versions WHERE version_id = $1 AND rule_pack_id = $2`,
        [version_id, id]
      );
      if (versionRes.rowCount === 0) {
        res.status(404).json({ error: "Version not found in this rule pack" });
        return;
      }

      // Run conflict check before publishing
      const rulesRes = await db.query<Rule>(
        `SELECT * FROM rules WHERE rule_pack_version_id = $1 AND active = true`,
        [version_id]
      );
      const conflicts = checkRuleConflicts(rulesRes.rows);
      if (conflicts.length > 0) {
        res.status(409).json({ error: "Cannot publish — rule conflicts detected", conflicts });
        return;
      }

      // Activate the pack (the published version is tracked via audit log)
      await db.query(
        `UPDATE rule_packs SET is_active = true WHERE rule_pack_id = $1`,
        [id]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "RULE_PACK",
        entity_id: id,
        agent_or_user: req.user!.user_id,
        action: "RULE_PACK_PUBLISHED",
        output_value: { version_id, version_number: versionRes.rows[0].version_number, rule_count: rulesRes.rowCount },
      });

      res.status(200).json({
        published: true,
        version: versionRes.rows[0],
        rule_count: rulesRes.rowCount,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Simulate Rules ──────────────────────────────────────────────────

router.post(
  "/:id/simulate",
  authenticate,
  rbac("ADMIN", "SENIOR_RECRUITER"),
  validate({ body: SimulateSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { version_id, candidates } = req.body as z.infer<typeof SimulateSchema>;

      // Use specified version or latest
      let targetVersionId = version_id ?? null;
      if (!targetVersionId) {
        const latestRes = await db.query(
          `SELECT version_id FROM rule_pack_versions WHERE rule_pack_id = $1 ORDER BY version_number DESC LIMIT 1`,
          [id]
        );
        targetVersionId = latestRes.rows[0]?.version_id ?? null;
      }
      if (!targetVersionId) {
        res.status(404).json({ error: "No versions found for this rule pack" });
        return;
      }

      const rulesRes = await db.query<Rule>(
        `SELECT * FROM rules WHERE rule_pack_version_id = $1 AND active = true`,
        [targetVersionId]
      );
      const rules = rulesRes.rows;

      // Simulate each candidate against each rule (no DB writes)
      const results = candidates.map((candidate, cIdx) => {
        const ruleResults = rules.map((rule) => {
          const fieldValue = extractField(candidate, rule.field_path);
          let status: "PASS" | "FAIL" | "NEEDS_REVIEW";
          let reasonCode: string;

          if (fieldValue === null || fieldValue === undefined) {
            status = "NEEDS_REVIEW";
            reasonCode = "MISSING_FIELD";
          } else {
            try {
              const pass = applyOperator(fieldValue, rule.operator, rule.threshold_value);
              status = pass ? "PASS" : "FAIL";
              reasonCode = pass ? "OK" : rule.fail_reason_code;
            } catch {
              status = "NEEDS_REVIEW";
              reasonCode = "RULE_EXCEPTION";
            }
          }

          return {
            rule_id: rule.rule_id,
            rule_code: rule.rule_code,
            rule_type: rule.rule_type,
            field_path: rule.field_path,
            input_value: fieldValue,
            status,
            reason_code: reasonCode,
          };
        });

        const passCount = ruleResults.filter((r) => r.status === "PASS").length;
        const failCount = ruleResults.filter((r) => r.status === "FAIL").length;
        const reviewCount = ruleResults.filter((r) => r.status === "NEEDS_REVIEW").length;
        const hasKnockout = ruleResults.some(
          (r) => r.status === "FAIL" && rules.find((rule) => rule.rule_id === r.rule_id)?.is_knockout
        );

        return {
          candidate_index: cIdx,
          overall: hasKnockout ? "KNOCKOUT" : failCount > 0 ? "FAIL" : reviewCount > 0 ? "NEEDS_REVIEW" : "PASS",
          pass: passCount,
          fail: failCount,
          needs_review: reviewCount,
          rule_results: ruleResults,
        };
      });

      const summary = {
        total: candidates.length,
        pass: results.filter((r) => r.overall === "PASS").length,
        fail: results.filter((r) => r.overall === "FAIL" || r.overall === "KNOCKOUT").length,
        needs_review: results.filter((r) => r.overall === "NEEDS_REVIEW").length,
        rule_count: rules.length,
      };

      res.status(200).json({ summary, results, version_id: targetVersionId });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Helpers ─────────────────────────────────────────────────────────

function extractField(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let node: any = obj;
  for (const segment of segments) {
    if (node === null || node === undefined) return null;
    node = node[segment];
  }
  return node === undefined ? null : node;
}

export default router;
