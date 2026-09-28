import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import { evaluatePersonaForEmployee } from "../../agents/persona_agent";

const router = Router();

const RequirementSchema = z.object({
  field_path: z.string().min(1),
  operator: z.enum(["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "IN", "NOT_IN", "REGEX"]),
  value: z.unknown(),
  weight: z.number().min(0),
});

const CreatePersonaSchema = z.object({
  department: z.string().min(1),
  job_family: z.string().min(1),
  name: z.string().min(1),
  requirements: z.array(RequirementSchema).min(1),
});

const IdParamSchema = z.object({ id: z.string().uuid() });
const EvaluateBodySchema = z.object({ employee_id: z.string().uuid(), profile: z.record(z.unknown()) });

/** POST /api/v1/personas — HR/Dept Head builds a departmental persona with weighted requirements. */
router.post(
  "/", authenticate, rbac("ADMIN", "DEPT_HEAD"), validate({ body: CreatePersonaSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { department, job_family, name, requirements } = req.body as z.infer<typeof CreatePersonaSchema>;
      const personaResult = await db.query(
        `INSERT INTO personas (org_id, department, job_family, name, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.user!.org_id, department, job_family, name, req.user!.user_id]
      );
      const personaId = personaResult.rows[0].persona_id;

      for (const r of requirements) {
        await db.query(
          `INSERT INTO persona_requirements (persona_id, field_path, operator, value, weight) VALUES ($1,$2,$3,$4,$5)`,
          [personaId, r.field_path, r.operator, JSON.stringify(r.value), r.weight]
        );
      }

      await logAudit({
        entity_type: "PERSONA", entity_id: personaId, agent_or_user: req.user!.user_id,
        action: "PERSONA_CREATED", output_value: { department, job_family, name, requirement_count: requirements.length },
      });
      res.status(201).json({ persona: personaResult.rows[0], requirement_count: requirements.length });
    } catch (err) { next(err); }
  }
);

/** GET /api/v1/personas */
router.get(
  "/", authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await db.query(`SELECT * FROM personas WHERE org_id=$1 AND active=true ORDER BY created_at DESC`, [req.user!.org_id]);
      res.status(200).json({ personas: result.rows, count: result.rowCount });
    } catch (err) { next(err); }
  }
);

/** POST /api/v1/personas/:id/evaluate — scores a profile against the persona. Human decides what to do with the fit score. */
router.post(
  "/:id/evaluate", authenticate, rbac("ADMIN", "DEPT_HEAD", "RECRUITER", "SENIOR_RECRUITER"),
  validate({ params: IdParamSchema, body: EvaluateBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as unknown as z.infer<typeof IdParamSchema>;
      const { employee_id, profile } = req.body as z.infer<typeof EvaluateBodySchema>;
      const result = await evaluatePersonaForEmployee(id, employee_id, profile, req.user!.org_id, req.user!.user_id);
      res.status(200).json({ persona_id: id, employee_id, ...result });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Persona not found")) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

export default router;
