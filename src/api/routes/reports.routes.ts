import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { reportGenerationRateLimit } from "../middleware/rate_limit";
import { generateReport } from "../../agents/report_agent";

const router = Router();

const QuerySchema = z.object({
  circular_id: z.string().min(1),
  type: z.enum(["FUNNEL", "SHORTLIST_SUMMARY", "VERIFICATION_STATUS", "AUDIT_LOGS"]).default("FUNNEL"),
  format: z.enum(["json", "pdf", "excel", "csv"]).default("json"),
});

/**
 * GET /api/v1/reports/generate
 * Standard reports (funnel analysis, shortlist summary, verification
 * status, audit logs) in json/pdf/excel/csv — all four formats render
 * from the exact same underlying data via the Report Agent
 * (src/agents/report_agent/index.ts), which also logs every generation
 * to audit_log.
 */
router.get(
  "/generate",
  authenticate,
  rbac("ADMIN", "RECRUITER", "AUDITOR"),
  reportGenerationRateLimit,
  validate({ query: QuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circular_id, type, format } = req.query as unknown as z.infer<typeof QuerySchema>;

      const report = await generateReport(type, circular_id, format, req.user!.org_id, req.user!.user_id);

      if (format === "json") {
        res.status(200).json({ circular_id, type, format, data: report.data });
        return;
      }

      res.setHeader("Content-Type", report.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`);
      res.status(200).send(report.buffer);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
