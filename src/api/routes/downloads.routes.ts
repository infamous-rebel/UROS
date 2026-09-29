/**
 * Quest 05 Part 8 — CSV template downloads.
 * Each endpoint requires JWT authentication and audit-logs the download.
 */
import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { logAudit } from "../../utils/audit_helper";

const router = Router();

const TEMPLATES: Record<string, string> = {
  candidates: "full_name,email,phone,source_platform,nationality,date_of_birth,cgpa\nJohn Doe,john@example.com,+8801700000000,bdjobs,Bangladeshi,2000-01-15,3.50",
  mcq: "question,option_a,option_b,option_c,option_d,correct_answer\nWhat is 2+2?,3,4,5,6,B",
  exam_questions: "section,question,option_a,option_b,option_c,option_d,correct_answer,marks\nMath,What is 2+2?,3,4,5,6,B,1",
  kpi: "role,kpi_name,weight,formula\nRECRUITER,time_to_hire_days,1,AVG(days_from_intake_to_selected)",
};

/**
 * GET /api/v1/templates/:type.csv
 * Returns a CSV template for the given type (candidates, mcq, exam_questions, kpi).
 */
router.get(
  "/:type.csv",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const template = TEMPLATES[req.params.type];
      if (!template) {
        res.status(404).json({ error: `Template '${req.params.type}' not found. Available: ${Object.keys(TEMPLATES).join(", ")}` });
        return;
      }

      await logAudit({
        org_id: req.user!.org_id,
        entity_type: "TEMPLATE",
        entity_id: req.params.type,
        agent_or_user: req.user!.user_id,
        action: "FILE_DOWNLOADED",
        output_value: { format: "csv", resource: "csv_template", template_type: req.params.type },
      });

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.type}-template.csv"`);
      res.send(template);
    } catch (err) { next(err); }
  }
);

export default router;
