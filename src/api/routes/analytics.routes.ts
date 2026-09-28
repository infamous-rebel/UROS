import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { rbac } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { reportGenerationRateLimit } from "../middleware/rate_limit";
import { db } from "../../database/client";
import { logAudit } from "../../utils/audit_helper";
import {
  DEFAULT_QUALITY_HIRE_DEFINITION,
  DEFAULT_TIME_WINDOW_DAYS,
} from "../../agents/recruitment_analytics_agent";
import { renderCsv, renderPdf, renderExcel } from "../../agents/report_agent";
import { RecruitmentAnalyticsConfig, SOURCE_PLATFORMS } from "../../models/recruitment_analytics.model";
import { AGENT_NAMES, invoke } from "../../services/agent_runner/agents";

/**
 * Agent-Level Hardening: every report below is produced by an agent and is
 * therefore invoked through the generic runner (`invoke`), which supplies
 * the timeout, transient-retry, circuit breaker, structured log and audit
 * trail. The report functions themselves are untouched — they are pure,
 * deterministic aggregations with no per-row side effects, so there is no
 * per-item loop to isolate here; the runner is the whole of the hardening.
 */
const analyticsCtx = (req: Request) => ({
  actor: req.user!.user_id,
  entity_type: "RECRUITMENT_ANALYTICS",
  entity_id: req.user!.org_id,
  request_id: req.requestId,
});

const router = Router();

const STAFF_READ_ROLES = ["ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "DEPT_HEAD"] as const;

const SourcePlatformEnum = z.enum(SOURCE_PLATFORMS as [string, ...string[]]);

const ThresholdsSchema = z.object({
  min_pass_rate: z.number().min(0).max(1).optional(),
  min_selection_rate: z.number().min(0).max(1).optional(),
  max_cost_per_quality_hire: z.number().min(0).optional(),
});

const CandidateStatusEnum = z.enum([
  "INTAKE",
  "PARSED",
  "ELIGIBILITY_DONE",
  "SCORED",
  "NEEDS_REVIEW",
  "ELIGIBLE_APPROVED",
  "SHORTLISTED",
  "VERIFIED",
  "REJECTED",
  "SELECTED",
  "WITHDRAWN",
]);

const ConfigureBodySchema = z.object({
  quality_hire_definition: z.object({
    hire_statuses: z.array(CandidateStatusEnum).min(1),
    min_score: z.number().nullable().default(null),
    thresholds: ThresholdsSchema.default({}),
  }),
  default_time_window_days: z.coerce.number().int().min(1).max(3650).default(DEFAULT_TIME_WINDOW_DAYS),
});

const SourceCostBodySchema = z.object({
  source_platform: SourcePlatformEnum,
  campaign_id: z.string().min(1).max(200).optional(),
  cost: z.coerce.number().min(0),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "effective_date must be YYYY-MM-DD"),
});

const SourcesQuerySchema = z.object({
  circular_id: z.string().min(1).optional(),
  time_window_days: z.coerce.number().int().min(1).max(3650).optional(),
});

const FunnelQuerySchema = z.object({
  circular_id: z.string().min(1),
});

const QualityHireQuerySchema = z.object({
  time_window_days: z.coerce.number().int().min(1).max(3650).optional(),
  source_platform: SourcePlatformEnum.optional(),
});

const ExportQuerySchema = z.object({
  report: z.enum(["sources", "funnel", "quality-hire"]),
  format: z.enum(["pdf", "csv", "excel"]),
  circular_id: z.string().min(1).optional(),
  time_window_days: z.coerce.number().int().min(1).max(3650).optional(),
});

/**
 * POST /api/v1/analytics/configure
 * Creates or updates the caller's org analytics config (one row per
 * org, upserted). A missing row is not "analytics disabled" — every
 * GET endpoint falls back to DEFAULT_QUALITY_HIRE_DEFINITION /
 * DEFAULT_TIME_WINDOW_DAYS, mirroring the fraud_checks precedent.
 */
router.post(
  "/configure",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ body: ConfigureBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { quality_hire_definition, default_time_window_days } = req.body as z.infer<typeof ConfigureBodySchema>;
      const orgId = req.user!.org_id;

      const result = await db.query<RecruitmentAnalyticsConfig>(
        `INSERT INTO recruitment_analytics_configs (org_id, quality_hire_definition, default_time_window_days, created_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id) DO UPDATE SET
           quality_hire_definition=EXCLUDED.quality_hire_definition,
           default_time_window_days=EXCLUDED.default_time_window_days,
           updated_at=now()
         RETURNING *`,
        [orgId, JSON.stringify(quality_hire_definition), default_time_window_days, req.user!.user_id]
      );

      await logAudit({
        entity_type: "RECRUITMENT_ANALYTICS_CONFIG",
        entity_id: result.rows[0].config_id,
        agent_or_user: req.user!.user_id,
        action: "ANALYTICS_CONFIGURED",
        output_value: { quality_hire_definition, default_time_window_days },
      });

      res.status(201).json({ config: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/analytics/config
 * Effective config for the caller's org — the configured row if one
 * exists, otherwise the system default. Never a dead 404: analytics
 * always has *an* effective configuration.
 */
router.get("/config", authenticate, rbac(...STAFF_READ_ROLES), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = req.user!.org_id;
    const res2 = await db.query<RecruitmentAnalyticsConfig>(`SELECT * FROM recruitment_analytics_configs WHERE org_id=$1`, [orgId]);
    if (res2.rowCount === 0) {
      res.status(200).json({
        config: null,
        effective_quality_hire_definition: DEFAULT_QUALITY_HIRE_DEFINITION,
        effective_default_time_window_days: DEFAULT_TIME_WINDOW_DAYS,
        is_system_default: true,
      });
      return;
    }
    res.status(200).json({
      config: res2.rows[0],
      effective_quality_hire_definition: res2.rows[0].quality_hire_definition,
      effective_default_time_window_days: res2.rows[0].default_time_window_days,
      is_system_default: false,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/analytics/source-costs
 * Records one cost entry for a source/campaign on a given date. Costs
 * accumulate (multiple rows per source/date are valid — e.g. separate
 * campaigns) rather than overwrite, so historical spend is never lost.
 */
router.post(
  "/source-costs",
  authenticate,
  rbac("ADMIN", "DEPT_HEAD"),
  validate({ body: SourceCostBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { source_platform, campaign_id, cost, effective_date } = req.body as z.infer<typeof SourceCostBodySchema>;
      const orgId = req.user!.org_id;

      const result = await db.query(
        `INSERT INTO recruitment_source_costs (org_id, source_platform, campaign_id, cost, effective_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [orgId, source_platform, campaign_id ?? null, cost, effective_date, req.user!.user_id]
      );

      await logAudit({
        entity_type: "RECRUITMENT_SOURCE_COST",
        entity_id: result.rows[0].cost_id,
        agent_or_user: req.user!.user_id,
        action: "SOURCE_COST_RECORDED",
        output_value: { source_platform, campaign_id: campaign_id ?? null, cost, effective_date },
      });

      res.status(201).json({ source_cost: result.rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/analytics/sources
 * Source effectiveness: pass rate, interview rate, selection rate per
 * source, plus underperformance flags. Optional circular_id narrows to
 * one recruitment; optional time_window_days overrides the org default.
 */
router.get(
  "/sources",
  authenticate,
  rbac(...STAFF_READ_ROLES),
  validate({ query: SourcesQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circular_id, time_window_days } = req.query as unknown as z.infer<typeof SourcesQuerySchema>;
      const report = await invoke(
        AGENT_NAMES.ANALYTICS_SOURCE_EFFECTIVENESS,
        { org_id: req.user!.org_id, actor: req.user!.user_id, options: { circular_id, time_window_days } },
        analyticsCtx(req)
      );
      res.status(200).json(report);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/analytics/funnel
 * Funnel stage counts (Applied → Eligible → Scored → Shortlisted →
 * Communicated → Selected) for one circular, org-scoped.
 */
router.get(
  "/funnel",
  authenticate,
  rbac(...STAFF_READ_ROLES),
  validate({ query: FunnelQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { circular_id } = req.query as unknown as z.infer<typeof FunnelQuerySchema>;
      const report = await invoke(
        AGENT_NAMES.ANALYTICS_FUNNEL,
        { org_id: req.user!.org_id, actor: req.user!.user_id, circular_id },
        analyticsCtx(req)
      );
      res.status(200).json(report);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/analytics/quality-hire
 * Cost per quality hire per source, using the org's configured (or
 * default) quality-hire definition, plus cost-related underperformance
 * flags.
 */
router.get(
  "/quality-hire",
  authenticate,
  rbac(...STAFF_READ_ROLES),
  validate({ query: QualityHireQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { time_window_days, source_platform } = req.query as unknown as z.infer<typeof QualityHireQuerySchema>;
      const report = await invoke(
        AGENT_NAMES.ANALYTICS_QUALITY_HIRE,
        {
          org_id: req.user!.org_id,
          actor: req.user!.user_id,
          options: {
            time_window_days,
            source_platform: source_platform as import("../../models/recruitment_analytics.model").SourcePlatform | undefined,
          },
        },
        analyticsCtx(req)
      );
      res.status(200).json(report);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/analytics/export?report=sources|funnel|quality-hire&format=pdf|csv|excel
 * Renders one of the three analytics reports as a downloadable file.
 * Reuses the Report Agent's deterministic renderCsv/renderPdf/renderExcel
 * (src/agents/report_agent/index.ts) so export formatting never diverges
 * from the standard reports feature — the underlying rows come from this
 * feature's own report functions above, never a second query path.
 */
router.get(
  "/export",
  authenticate,
  rbac("ADMIN", "RECRUITER", "SENIOR_RECRUITER", "AUDITOR", "DEPT_HEAD"),
  reportGenerationRateLimit,
  validate({ query: ExportQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { report: reportType, format, circular_id, time_window_days } = req.query as unknown as z.infer<typeof ExportQuerySchema>;
      const orgId = req.user!.org_id;
      const actor = req.user!.user_id;

      let rows: Record<string, unknown>[];
      let title: string;
      let safeName: string;

      if (reportType === "sources") {
        const r = await invoke(
          AGENT_NAMES.ANALYTICS_SOURCE_EFFECTIVENESS,
          { org_id: orgId, actor, options: { circular_id, time_window_days } },
          analyticsCtx(req)
        );
        rows = r.sources as unknown as Record<string, unknown>[];
        title = `Source Effectiveness — ${circular_id ?? "All Circulars"}`;
        safeName = `source_effectiveness_${(circular_id ?? "all").replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      } else if (reportType === "funnel") {
        if (!circular_id) {
          res.status(400).json({ error: "circular_id is required for format=funnel" });
          return;
        }
        const r = await invoke(
          AGENT_NAMES.ANALYTICS_FUNNEL,
          { org_id: orgId, actor, circular_id },
          analyticsCtx(req)
        );
        rows = r.stages as unknown as Record<string, unknown>[];
        title = `Funnel Analysis — ${circular_id}`;
        safeName = `funnel_${circular_id.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      } else {
        const r = await invoke(
          AGENT_NAMES.ANALYTICS_QUALITY_HIRE,
          { org_id: orgId, actor, options: { time_window_days } },
          analyticsCtx(req)
        );
        rows = r.sources as unknown as Record<string, unknown>[];
        title = `Cost Per Quality Hire`;
        safeName = `quality_hire_cost`;
      }

      await logAudit({
        entity_type: "RECRUITMENT_ANALYTICS",
        entity_id: orgId,
        agent_or_user: actor,
        action: "ANALYTICS_REPORT_EXPORTED",
        reason_code: "ANALYTICS_REPORT_EXPORTED",
        reason_comment: `${reportType} analytics report exported in ${format} format (${rows.length} row(s)).`,
        output_value: { report: reportType, format, row_count: rows.length },
      });

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${safeName}.csv"`);
        res.status(200).send(renderCsv(rows));
        return;
      }
      if (format === "excel") {
        const buffer = await renderExcel(title, rows);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${safeName}.xlsx"`);
        res.status(200).send(buffer);
        return;
      }
      const buffer = await renderPdf(title, rows);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
      res.status(200).send(buffer);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
