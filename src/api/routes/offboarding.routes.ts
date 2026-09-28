import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import {
  configureOffboardingTemplate,
  startOffboardingCase,
  getOffboardingCaseWithSteps,
  completeOffboardingStep,
  reviewOffboardingStep,
  InvalidStepTransitionError,
} from "../../agents/offboarding_agent";

const router = Router();

// ---------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------

const ChecklistItemSchema = z.object({
  item_code: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  category: z.string().max(100).optional(),
  default_assignee_user_id: z.string().uuid().nullable().optional(),
  default_due_days_from_exit: z.number().int().min(-365).max(365).optional(),
});

const ConfigureBodySchema = z.object({
  template_id: z.string().uuid().optional(),
  role: z.string().min(1).max(200),
  checklist: z.array(ChecklistItemSchema).min(1).max(100),
});

const StepOverrideSchema = z.object({
  item_code: z.string().min(1).max(100),
  assigned_to: z.string().uuid().nullable().optional(),
  due_date: z.string().datetime().nullable().optional(),
});

const StartBodySchema = z.object({
  employee_id: z.string().uuid(),
  template_id: z.string().uuid(),
  exit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "exit_date must be YYYY-MM-DD"),
  step_overrides: z.array(StepOverrideSchema).max(100).optional(),
});

const CaseIdParamSchema = z.object({ case_id: z.string().uuid() });
const StepIdParamSchema = z.object({ step_id: z.string().uuid() });

const StepPatchBodySchema = z.object({
  action: z.enum(["COMPLETE", "APPROVE", "REJECT"]),
  reason: z.string().min(1, "reason is mandatory"),
  evidence: z.record(z.unknown()).optional(),
});

const STAFF_ROLES = ["ADMIN", "RECRUITER", "SENIOR_RECRUITER", "DEPT_HEAD"] as const;
const STAFF_READ_ROLES = ["ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "DEPT_HEAD"] as const;
/** Separation of duties (16_User_Roles_and_Permissions_Matrix.md §4): a plain RECRUITER can COMPLETE a step but not APPROVE/REJECT its closure. */
const APPROVAL_ROLES = new Set(["ADMIN", "SENIOR_RECRUITER", "DEPT_HEAD"]);

// ---------------------------------------------------------------------
// POST /api/v1/offboarding/configure
// ---------------------------------------------------------------------

/** Creates a new offboarding template, or updates an existing one (when template_id is supplied) owned by the same org. */
router.post(
  "/configure",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ body: ConfigureBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { template_id, role, checklist } = req.body as z.infer<typeof ConfigureBodySchema>;
      const template = await configureOffboardingTemplate(
        req.user!.org_id,
        role,
        checklist,
        req.user!.user_id,
        template_id
      );
      res.status(template_id ? 200 : 201).json({ template });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (/duplicate item_code/i.test(err?.message ?? "")) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// POST /api/v1/offboarding/start
// ---------------------------------------------------------------------

/** Starts an offboarding case for an employee from a template, expanding the checklist into concrete steps. */
router.post(
  "/start",
  authenticate,
  rbac(...STAFF_ROLES),
  validate({ body: StartBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employee_id, template_id, exit_date, step_overrides } = req.body as z.infer<typeof StartBodySchema>;
      const result = await startOffboardingCase(
        employee_id,
        template_id,
        exit_date,
        req.user!.org_id,
        req.user!.user_id,
        step_overrides ?? []
      );
      res.status(201).json({ case: result.case, steps: result.steps });
    } catch (err: any) {
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (/already has an active offboarding case/i.test(err?.message ?? "")) {
        res.status(409).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// GET /api/v1/offboarding/cases/:case_id
// ---------------------------------------------------------------------

/** Views a case with its full step list, org-scoped. */
router.get(
  "/cases/:case_id",
  authenticate,
  rbac(...STAFF_READ_ROLES),
  validate({ params: CaseIdParamSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { case_id } = req.params as unknown as z.infer<typeof CaseIdParamSchema>;
      const result = await getOffboardingCaseWithSteps(case_id, req.user!.org_id);
      if (!result) {
        res.status(404).json({ error: "Offboarding case not found" });
        return;
      }
      res.status(200).json({ case: result.case, steps: result.steps, step_count: result.steps.length });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// PATCH /api/v1/offboarding/steps/:step_id
// ---------------------------------------------------------------------

/**
 * Advances a single step: COMPLETE (assignee self-report), or APPROVE /
 * REJECT (human closure decision — the only path that finalizes a step).
 * `reason` is mandatory for every action, not only overrides.
 */
router.patch(
  "/steps/:step_id",
  authenticate,
  rbac(...STAFF_ROLES),
  validate({ params: StepIdParamSchema, body: StepPatchBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { step_id } = req.params as unknown as z.infer<typeof StepIdParamSchema>;
      const { action, reason, evidence } = req.body as z.infer<typeof StepPatchBodySchema>;

      if ((action === "APPROVE" || action === "REJECT") && !APPROVAL_ROLES.has(req.user!.role)) {
        res.status(403).json({
          error: "Forbidden",
          detail: `Role '${req.user!.role}' cannot approve or reject an offboarding step closure`,
        });
        return;
      }

      if (action === "COMPLETE") {
        const step = await completeOffboardingStep(step_id, req.user!.org_id, req.user!.user_id, reason, evidence ?? {});
        res.status(200).json({ step });
        return;
      }

      const result = await reviewOffboardingStep(
        step_id,
        req.user!.org_id,
        req.user!.user_id,
        action,
        reason
      );
      res.status(200).json({ step: result.step, case_completed: result.case_completed });
    } catch (err: any) {
      if (err instanceof InvalidStepTransitionError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (/not found/i.test(err?.message ?? "")) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (/mandatory/i.test(err?.message ?? "")) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

export default router;
