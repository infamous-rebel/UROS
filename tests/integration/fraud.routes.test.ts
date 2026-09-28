import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeFraudDb } from "../helpers/fake_fraud_db";

const fake = createFakeFraudDb();

jest.mock("../../src/database/client", () => ({ db: fake.db }));

// Imported after the mock is registered so every module that pulls in
// database/client (agent, routes, audit_helper) gets the fake.
import fraudRoutes from "../../src/api/routes/fraud.routes";
import { errorHandler } from "../../src/api/middleware/error_handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/fraud", fraudRoutes);
  app.use(errorHandler);
  return app;
}

function tokenFor(role: string, orgId = "org-1", userId = "user-1"): string {
  return jwt.sign({ user_id: userId, org_id: orgId, role }, process.env.JWT_SECRET as string);
}

const ADMIN_TOKEN = tokenFor("ADMIN");
const RECRUITER_TOKEN = tokenFor("RECRUITER");
const AUDITOR_TOKEN = tokenFor("AUDITOR");

beforeEach(() => {
  fake.state.candidates.length = 0;
  fake.state.candidate_academic_records.length = 0;
  fake.state.candidate_experience.length = 0;
  fake.state.fraud_checks.length = 0;
  fake.state.fraud_flags.length = 0;
  fake.state.audit_log.length = 0;

  fake.state.candidates.push(
    {
      candidate_id: "UROS-TEST-0001",
      org_id: "org-1",
      full_name: "Candidate One",
      date_of_birth: "1990-01-01",
      national_id: "NID-SHARED-100",
      phone_primary: "01711111111",
      email: "one@example.com",
      job_circular_id: "CIRC-1",
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      candidate_id: "UROS-TEST-0002",
      org_id: "org-1",
      full_name: "Candidate Two",
      date_of_birth: "1991-01-01",
      national_id: "NID-SHARED-100",
      phone_primary: "01722222222",
      email: "two@example.com",
      job_circular_id: "CIRC-1",
      created_at: "2026-01-02T00:00:00Z",
    }
  );
  fake.state.candidate_academic_records.push({
    candidate_id: "UROS-TEST-0001",
    level: "Bachelor",
    passing_year: 2011,
    division_class: "First",
    cgpa: 3.8,
    result_scale: "out of 4",
  });
});

const app = buildApp();

describe("POST /api/v1/fraud/configure", () => {
  it("rejects non-admin/dept-head roles", async () => {
    const res = await request(app)
      .post("/api/v1/fraud/configure")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ check_type: "EXPERIENCE_OVERLAP", name: "Custom overlap", config: { max_allowed_overlap_days: 5 } });
    expect(res.status).toBe(403);
  });

  it("creates a fraud check as ADMIN, deactivates any prior active row of the same type, and audits it", async () => {
    const first = await request(app)
      .post("/api/v1/fraud/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ check_type: "EXPERIENCE_OVERLAP", name: "Overlap v1", config: { max_allowed_overlap_days: 10 } });
    expect(first.status).toBe(201);
    expect(first.body.fraud_check.active).toBe(true);

    const second = await request(app)
      .post("/api/v1/fraud/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ check_type: "EXPERIENCE_OVERLAP", name: "Overlap v2", config: { max_allowed_overlap_days: 5 }, is_knockout: true });
    expect(second.status).toBe(201);

    const activeRows = fake.state.fraud_checks.filter((c) => c.check_type === "EXPERIENCE_OVERLAP" && c.active);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].name).toBe("Overlap v2");
    expect(fake.state.audit_log.some((a) => a.params.includes("FRAUD_CHECK_CONFIGURED"))).toBe(true);
  });

  it("rejects an unknown check_type", async () => {
    const res = await request(app)
      .post("/api/v1/fraud/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ check_type: "NOT_A_REAL_CHECK", name: "x", config: {} });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/fraud/checks", () => {
  it("returns all 5 check types, using system defaults when unconfigured", async () => {
    const res = await request(app).get("/api/v1/fraud/checks").set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(5);
    expect(res.body.checks.every((c: any) => c.is_system_default)).toBe(true);
  });

  it("reflects an org's configured override instead of the default", async () => {
    await request(app)
      .post("/api/v1/fraud/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ check_type: "DUPLICATE_IDENTITY", name: "Strict dupes", config: { fields: ["national_id"] }, is_knockout: true });

    const res = await request(app).get("/api/v1/fraud/checks").set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    const dup = res.body.checks.find((c: any) => c.check_type === "DUPLICATE_IDENTITY");
    expect(dup.is_system_default).toBe(false);
    expect(dup.is_knockout).toBe(true);
    expect(dup.name).toBe("Strict dupes");
  });
});

describe("POST /api/v1/fraud/run + GET /api/v1/fraud/flags/:candidate_id", () => {
  it("flags both candidates for a shared national_id and stores full evidence", async () => {
    const runRes = await request(app)
      .post("/api/v1/fraud/run")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ candidate_ids: ["UROS-TEST-0001", "UROS-TEST-0002"] });

    expect(runRes.status).toBe(200);
    expect(runRes.body.count).toBe(2);
    for (const r of runRes.body.results) {
      expect(r.flags_created.some((f: any) => f.reason_code === "DUPLICATE_NATIONAL_ID")).toBe(true);
    }

    const flagsRes = await request(app)
      .get("/api/v1/fraud/flags/UROS-TEST-0001")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(flagsRes.status).toBe(200);
    const dupFlag = flagsRes.body.flags.find((f: any) => f.reason_code === "DUPLICATE_NATIONAL_ID");
    expect(dupFlag).toBeDefined();
    expect(dupFlag.severity).toBe("HIGH");
    expect(dupFlag.status).toBe("OPEN");
    expect(dupFlag.evidence.matches[0].matched_candidate_id).toBe("UROS-TEST-0002");
  });

  it("runs an entire circular when circular_id is given instead of candidate_ids", async () => {
    const runRes = await request(app)
      .post("/api/v1/fraud/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ circular_id: "CIRC-1" });
    expect(runRes.status).toBe(200);
    expect(runRes.body.count).toBe(2);
  });

  it("isolates a per-candidate failure without failing the rest of the batch", async () => {
    const runRes = await request(app)
      .post("/api/v1/fraud/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ candidate_ids: ["UROS-TEST-0001", "DOES-NOT-EXIST"] });
    expect(runRes.status).toBe(200);
    const failed = runRes.body.results.find((r: any) => r.candidate_id === "DOES-NOT-EXIST");
    const succeeded = runRes.body.results.find((r: any) => r.candidate_id === "UROS-TEST-0001");
    expect(failed.error).toContain("Candidate not found");
    expect(succeeded.error).toBeUndefined();
  });

  it("returns 404 for a candidate not in the caller's org", async () => {
    const res = await request(app)
      .get("/api/v1/fraud/flags/NOT-A-CANDIDATE")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("rejects run requests with neither candidate_ids nor circular_id", async () => {
    const res = await request(app).post("/api/v1/fraud/run").set("Authorization", `Bearer ${ADMIN_TOKEN}`).send({});
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/v1/fraud/flags/:flag_id", () => {
  async function seedOneFlag(): Promise<string> {
    const runRes = await request(app)
      .post("/api/v1/fraud/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ candidate_ids: ["UROS-TEST-0001"] });
    return runRes.body.results[0].flags_created[0].flag_id;
  }

  it("requires a mandatory resolution_reason", async () => {
    const flagId = await seedOneFlag();
    const res = await request(app)
      .patch(`/api/v1/fraud/flags/${flagId}`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ resolution: "CONFIRMED" });
    expect(res.status).toBe(400);
  });

  it("resolves a flag as CONFIRMED with a reason, stamping reviewer and auditing it", async () => {
    const flagId = await seedOneFlag();
    const res = await request(app)
      .patch(`/api/v1/fraud/flags/${flagId}`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ resolution: "CONFIRMED", resolution_reason: "Verified against NID database — confirmed duplicate." });

    expect(res.status).toBe(200);
    expect(res.body.flag.status).toBe("CONFIRMED");
    expect(res.body.flag.resolution).toBe("CONFIRMED");
    expect(res.body.flag.reviewed_by).toBe("user-1");
    expect(fake.state.audit_log.some((a) => a.params.includes("FRAUD_FLAG_CONFIRMED"))).toBe(true);
  });

  it("resolves a flag as FALSE_POSITIVE with a reason", async () => {
    const flagId = await seedOneFlag();
    const res = await request(app)
      .patch(`/api/v1/fraud/flags/${flagId}`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ resolution: "FALSE_POSITIVE", resolution_reason: "Same person re-applied; not fraud." });
    expect(res.status).toBe(200);
    expect(res.body.flag.status).toBe("FALSE_POSITIVE");
  });

  it("returns 404 for an unknown flag id", async () => {
    const res = await request(app)
      .patch(`/api/v1/fraud/flags/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ resolution: "ESCALATED", resolution_reason: "Needs senior review." });
    expect(res.status).toBe(404);
  });

  it("rejects APPLICANT role from resolving flags", async () => {
    const flagId = await seedOneFlag();
    const res = await request(app)
      .patch(`/api/v1/fraud/flags/${flagId}`)
      .set("Authorization", `Bearer ${tokenFor("APPLICANT")}`)
      .send({ resolution: "CONFIRMED", resolution_reason: "x" });
    expect(res.status).toBe(403);
  });
});
