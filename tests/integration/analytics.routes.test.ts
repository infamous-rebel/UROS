import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeAnalyticsDb } from "../helpers/fake_analytics_db";

const fake = createFakeAnalyticsDb();

jest.mock("../../src/database/client", () => ({ db: fake.db }));

// Imported after the mock is registered so every module that pulls in
// database/client (agent, routes, audit_helper, report_agent) gets the fake.
import analyticsRoutes from "../../src/api/routes/analytics.routes";
import { errorHandler } from "../../src/api/middleware/error_handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/analytics", analyticsRoutes);
  app.use(errorHandler);
  return app;
}

function tokenFor(role: string, orgId = "org-1", userId = "user-1"): string {
  return jwt.sign({ user_id: userId, org_id: orgId, role }, process.env.JWT_SECRET as string);
}

const ADMIN_TOKEN = tokenFor("ADMIN");
const RECRUITER_TOKEN = tokenFor("RECRUITER");
const AUDITOR_TOKEN = tokenFor("AUDITOR");

const NOW = new Date();
function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}
function dateDaysAgo(n: number): string {
  return daysAgo(n).slice(0, 10);
}

const app = buildApp();

beforeEach(() => {
  fake.state.candidates.length = 0;
  fake.state.evaluation_results.length = 0;
  fake.state.scoring_results.length = 0;
  fake.state.communication_log.length = 0;
  fake.state.recruitment_analytics_configs.length = 0;
  fake.state.recruitment_source_costs.length = 0;
  fake.state.audit_log.length = 0;

  fake.state.candidates.push(
    { candidate_id: "C-1", org_id: "org-1", source_platform: "bdjobs", job_circular_id: "CIRC-1", status: "SELECTED", application_date: daysAgo(10), created_at: daysAgo(10) },
    { candidate_id: "C-2", org_id: "org-1", source_platform: "bdjobs", job_circular_id: "CIRC-1", status: "SHORTLISTED", application_date: daysAgo(9), created_at: daysAgo(9) },
    { candidate_id: "C-3", org_id: "org-1", source_platform: "bdjobs", job_circular_id: "CIRC-1", status: "REJECTED", application_date: daysAgo(8), created_at: daysAgo(8) },
    { candidate_id: "C-4", org_id: "org-1", source_platform: "LinkedIn", job_circular_id: "CIRC-1", status: "REJECTED", application_date: daysAgo(7), created_at: daysAgo(7) },
    // Different org — must never leak into org-1 reports
    { candidate_id: "C-5", org_id: "org-2", source_platform: "bdjobs", job_circular_id: "CIRC-1", status: "SELECTED", application_date: daysAgo(5), created_at: daysAgo(5) }
  );
  fake.state.evaluation_results.push(
    { candidate_id: "C-1", status: "PASS" },
    { candidate_id: "C-2", status: "PASS" },
    { candidate_id: "C-3", status: "FAIL" },
    { candidate_id: "C-4", status: "FAIL" }
  );
  fake.state.scoring_results.push(
    { candidate_id: "C-1", total_score: 88, computed_at: daysAgo(9) },
    { candidate_id: "C-2", total_score: 72, computed_at: daysAgo(8) }
  );
  fake.state.communication_log.push({ candidate_id: "C-1" }, { candidate_id: "C-2" });
});

describe("POST /api/v1/analytics/configure", () => {
  it("rejects non-admin/dept-head roles", async () => {
    const res = await request(app)
      .post("/api/v1/analytics/configure")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ quality_hire_definition: { hire_statuses: ["SELECTED"], thresholds: {} } });
    expect(res.status).toBe(403);
  });

  it("creates a config as ADMIN and audits it", async () => {
    const res = await request(app)
      .post("/api/v1/analytics/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        quality_hire_definition: { hire_statuses: ["SELECTED"], min_score: 70, thresholds: { min_pass_rate: 0.1 } },
        default_time_window_days: 60,
      });
    expect(res.status).toBe(201);
    expect(res.body.config.quality_hire_definition.min_score).toBe(70);
    expect(res.body.config.default_time_window_days).toBe(60);
    expect(fake.state.audit_log.some((a) => a.params.includes("ANALYTICS_CONFIGURED"))).toBe(true);
  });

  it("upserts — a second configure call updates the same org row rather than creating a second one", async () => {
    await request(app)
      .post("/api/v1/analytics/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ quality_hire_definition: { hire_statuses: ["SELECTED"], thresholds: {} }, default_time_window_days: 30 });

    const second = await request(app)
      .post("/api/v1/analytics/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ quality_hire_definition: { hire_statuses: ["SELECTED", "VERIFIED"], thresholds: {} }, default_time_window_days: 45 });

    expect(second.status).toBe(201);
    expect(fake.state.recruitment_analytics_configs).toHaveLength(1);
    expect(fake.state.recruitment_analytics_configs[0].default_time_window_days).toBe(45);
  });

  it("rejects an empty hire_statuses array", async () => {
    const res = await request(app)
      .post("/api/v1/analytics/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ quality_hire_definition: { hire_statuses: [], thresholds: {} } });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/analytics/config", () => {
  it("returns system defaults when unconfigured", async () => {
    const res = await request(app).get("/api/v1/analytics/config").set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.is_system_default).toBe(true);
    expect(res.body.effective_quality_hire_definition.hire_statuses).toEqual(["SELECTED"]);
  });
});

describe("POST /api/v1/analytics/source-costs", () => {
  it("rejects non-admin/dept-head roles", async () => {
    const res = await request(app)
      .post("/api/v1/analytics/source-costs")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ source_platform: "bdjobs", cost: 1000, effective_date: dateDaysAgo(5) });
    expect(res.status).toBe(403);
  });

  it("records a cost entry as ADMIN and audits it", async () => {
    const res = await request(app)
      .post("/api/v1/analytics/source-costs")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ source_platform: "bdjobs", campaign_id: "camp-1", cost: 15000, effective_date: dateDaysAgo(5) });
    expect(res.status).toBe(201);
    expect(res.body.source_cost.cost).toBe(15000);
    expect(fake.state.audit_log.some((a) => a.params.includes("SOURCE_COST_RECORDED"))).toBe(true);
  });

  it("rejects a negative cost", async () => {
    const res = await request(app)
      .post("/api/v1/analytics/source-costs")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ source_platform: "bdjobs", cost: -5, effective_date: dateDaysAgo(1) });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown source_platform", async () => {
    const res = await request(app)
      .post("/api/v1/analytics/source-costs")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ source_platform: "TikTok", cost: 5, effective_date: dateDaysAgo(1) });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/analytics/sources", () => {
  it("computes pass/interview/selection rates per source, org-scoped", async () => {
    const res = await request(app).get("/api/v1/analytics/sources").set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(200);
    const bdjobs = res.body.sources.find((s: any) => s.source_platform === "bdjobs");
    expect(bdjobs.total_candidates).toBe(3);
    expect(bdjobs.eligible_pass_count).toBe(2);
    expect(bdjobs.selection_count).toBe(1);
    // org-2's candidate must never appear
    expect(res.body.sources.reduce((sum: number, s: any) => sum + s.total_candidates, 0)).toBe(4);
    expect(fake.state.audit_log.some((a) => a.params.includes("ANALYTICS_SOURCES_COMPUTED"))).toBe(true);
  });

  it("narrows to a circular_id when provided", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/sources?circular_id=CIRC-1")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.circular_id).toBe("CIRC-1");
  });

  it("includes an underperformance flag when the org has configured a threshold the data violates", async () => {
    await request(app)
      .post("/api/v1/analytics/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ quality_hire_definition: { hire_statuses: ["SELECTED"], thresholds: { min_selection_rate: 0.5 } }, default_time_window_days: 90 });

    const res = await request(app).get("/api/v1/analytics/sources").set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(200);
    const flag = res.body.flags.find((f: any) => f.source_platform === "bdjobs" && f.reason_code === "SOURCE_SELECTION_RATE_BELOW_THRESHOLD");
    expect(flag).toBeDefined();
    expect(flag.reason_description).toContain("bdjobs");
    expect(flag.evidence.selection_rate).toBeCloseTo(1 / 3);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/v1/analytics/sources");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/analytics/funnel", () => {
  it("requires circular_id", async () => {
    const res = await request(app).get("/api/v1/analytics/funnel").set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(400);
  });

  it("computes funnel stages for the circular", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/funnel?circular_id=CIRC-1")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(200);
    const byStage = Object.fromEntries(res.body.stages.map((s: any) => [s.stage, s.count]));
    expect(byStage.APPLIED).toBe(4);
    expect(byStage.ELIGIBLE).toBe(2);
    expect(byStage.SCORED).toBe(2);
    expect(byStage.SHORTLISTED).toBe(2);
    expect(byStage.COMMUNICATED).toBe(2);
    expect(byStage.SELECTED).toBe(1);
    expect(fake.state.audit_log.some((a) => a.params.includes("ANALYTICS_FUNNEL_COMPUTED"))).toBe(true);
  });
});

describe("GET /api/v1/analytics/quality-hire", () => {
  it("computes cost per quality hire per source using recorded costs", async () => {
    await request(app)
      .post("/api/v1/analytics/source-costs")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ source_platform: "bdjobs", cost: 20000, effective_date: dateDaysAgo(9) });

    const res = await request(app).get("/api/v1/analytics/quality-hire").set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(200);
    const bdjobs = res.body.sources.find((s: any) => s.source_platform === "bdjobs");
    expect(bdjobs.total_cost).toBe(20000);
    expect(bdjobs.quality_hire_count).toBe(1); // only C-1 is SELECTED
    expect(bdjobs.cost_per_quality_hire).toBe(20000);
    expect(fake.state.audit_log.some((a) => a.params.includes("ANALYTICS_QUALITY_HIRE_COMPUTED"))).toBe(true);
  });

  it("flags zero quality hires with recorded spend", async () => {
    await request(app)
      .post("/api/v1/analytics/source-costs")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ source_platform: "LinkedIn", cost: 5000, effective_date: dateDaysAgo(6) });

    const res = await request(app).get("/api/v1/analytics/quality-hire").set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    const flag = res.body.flags.find((f: any) => f.source_platform === "LinkedIn" && f.reason_code === "SOURCE_ZERO_QUALITY_HIRES_WITH_SPEND");
    expect(flag).toBeDefined();
  });

  it("filters by source_platform when given", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/quality-hire?source_platform=bdjobs")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.sources.every((s: any) => s.source_platform === "bdjobs")).toBe(true);
  });
});

describe("GET /api/v1/analytics/export", () => {
  it("exports the sources report as CSV", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/export?report=sources&format=csv")
      .set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("source_platform");
    expect(fake.state.audit_log.some((a) => a.params.includes("ANALYTICS_REPORT_EXPORTED"))).toBe(true);
  });

  it("exports the funnel report as PDF when circular_id is given", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/export?report=funnel&format=pdf&circular_id=CIRC-1")
      .set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("rejects a funnel export without circular_id", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/export?report=funnel&format=pdf")
      .set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(400);
  });

  it("exports the quality-hire report as excel", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/export?report=quality-hire&format=excel")
      .set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
  });

  it("rejects an unsupported format", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/export?report=sources&format=json")
      .set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(400);
  });
});
