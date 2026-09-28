import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { triageAppeal } from "../../agents/appeal_triage_agent";
import { tenantLookups } from "../middleware/validate_tenant_access";

const router = Router();

const SubmitBodySchema = z.object({
  candidate_id: z.string().min(1),
  reason_text: z.string().min(1),
  category: z.enum(["Data Error", "Rule Misapplication", "Document Update", "Quota Dispute"]),
});

const ListQuerySchema = z.object({
  status: z.enum(["SUBMITTED", "TRIAGED", "UNDER_REVIEW", "RESOLVED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const IdParamSchema = z.object({ id: z.string().uuid() });

const PatchBodySchema = z.object({
  status: z.enum(["UNDER_REVIEW", "RESOLVED"]),
  resolution: z.string().min(1, "resolution is mandatory when changing appeal status"),
});

/** POST /api/v1/appeals — Applicant (own record only) or Admin submits an appeal. Auto-triaged on submission. */
router.post(
  "/",
  authenticate,
  rbac("APPLICANT", "ADMIN"),
  validate({ body: SubmitBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { candidate_id, reason_text, category } = req.body as z.infer<typeof SubmitBodySchema>;

      if (req.user!.role === "APPLICANT" && req.user!.user_id !== candidate_id) {
        res.status(403).json({ error: "Applicants may only appeal their own application" });
        return;
      }

      // Security Hardening Round: an ADMIN could previously submit (and
      // have auto-triaged) an appeal for a candidate_id belonging to
      // another org — triageAppeal would then assign it to *this* org's
      // senior recruiters for a candidate they have no relationship to.
      // candidate_id must always resolve within the caller's own org.
      const candidateInOrg = await tenantLookups.candidate(candidate_id, req.user!.org_id);
      if (!candidateInOrg) {
        res.status(404).json({ error: "Candidate not found" });
        return;
      }

      const result = await db.query(
        `INSERT INTO appeals (candidate_id, org_id, reason_text, category, status)
         VALUES ($1,$2,$3,$4,'SUBMITTED')
         RETURNING appeal_id, submitted_at`,
        [candidate_id, req.user!.org_id, reason_text, category]
      );
      const appealId = result.rows[0].appeal_id;

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "APPEAL",
        entity_id: appealId,
        agent_or_user: req.user!.user_id,
        action: "APPEAL_SUBMITTED",
        output_value: { candidate_id, category },
      });

      await triageAppeal(appealId, req.user!.org_id);

      res.status(201).json({ appeal_id: appealId, status: "TRIAGED", submitted_at: result.rows[0].submitted_at });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/appeals — Senior Recruiter/Admin/Auditor see all in org scope; Applicant sees only their own. */
router.get(
  "/",
  authenticate,
  rbac("SENIOR_RECRUITER", "ADMIN", "AUDITOR", "APPLICANT"),
  validate({ query: ListQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, limit, offset } = req.query as unknown as z.infer<typeof ListQuerySchema>;
      // Security Hardening Round: appeals has no org_id column, so
      // org scoping must go through a join to candidates.org_id —
      // previously this endpoint had no org filter at all and any
      // staff role could list every org's appeals.
      const conditions: string[] = ["c.org_id = $1"];
      const params: unknown[] = [req.user!.org_id];

      if (req.user!.role === "APPLICANT") {
        params.push(req.user!.user_id);
        conditions.push(`a.candidate_id = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`a.status = $${params.length}`);
      }
      params.push(limit);
      params.push(offset);

      const result = await db.query(
        `SELECT a.* FROM appeals a JOIN candidates c ON c.candidate_id = a.candidate_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY a.submitted_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      res.status(200).json({ appeals: result.rows, count: result.rowCount, limit, offset });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/appeals/:id */
router.get(
  "/:id",
  authenticate,
  rbac("SENIOR_RECRUITER", "ADMIN", "AUDITOR", "APPLICANT"),
  validate({ params: IdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const result = await db.query(
        `SELECT a.* FROM appeals a JOIN candidates c ON c.candidate_id = a.candidate_id
         WHERE a.appeal_id=$1 AND c.org_id=$2`,
        [id, req.user!.org_id]
      );
      if (result.rowCount === 0) { res.status(404).json({ error: "Appeal not found" }); return; }
      if (req.user!.role === "APPLICANT" && result.rows[0].candidate_id !== req.user!.user_id) {
        res.status(403).json({ error: "Not your appeal" });
        return;
      }
      res.status(200).json({ appeal: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/** PATCH /api/v1/appeals/:id — Senior Recruiter/Admin resolve an appeal. Mandatory resolution text, fully audited. */
router.patch(
  "/:id",
  authenticate,
  rbac("SENIOR_RECRUITER", "ADMIN"),
  validate({ params: IdParamSchema, body: PatchBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const { status, resolution } = req.body as z.infer<typeof PatchBodySchema>;

      const existing = await db.query(
        `SELECT a.* FROM appeals a JOIN candidates c ON c.candidate_id = a.candidate_id
         WHERE a.appeal_id=$1 AND c.org_id=$2`,
        [id, req.user!.org_id]
      );
      if (existing.rowCount === 0) { res.status(404).json({ error: "Appeal not found" }); return; }

      const resolvedAtClause = status === "RESOLVED" ? "resolved_at=now()," : "";
      const updated = await db.query(
        `UPDATE appeals SET status=$1, resolution=$2, ${resolvedAtClause} assigned_to=COALESCE(assigned_to,$3)
         WHERE appeal_id=$4 AND org_id=$5 RETURNING *`,
        [status, resolution, req.user!.user_id, id, req.user!.org_id]
      );

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "APPEAL",
        entity_id: id,
        agent_or_user: req.user!.user_id,
        action: "APPEAL_" + status,
        reason_comment: resolution,
      });

      res.status(200).json({ appeal: updated.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
