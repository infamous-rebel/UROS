import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeOffboardingDb } from "../helpers/fake_offboarding_db";

const fake = createFakeOffboardingDb();

jest.mock("../../src/database/client", () => ({ db: fake.db }));

// Imported after the mock is registered so every module that pulls in
// database/client (routes, agent, audit_helper) gets the fake.
import offboardingRoutes from "../../src/api/routes/offboarding.routes";
import { errorHandler } from "../../src/api/middleware/error_handler";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/offboarding", offboardingRoutes);
  app.use(errorHandler);
  return app;
}

function tokenFor(role: string, orgId = "org-1", userId = "user-1"): string {
  return jwt.sign({ user_id: userId, org_id: orgId, role }, process.env.JWT_SECRET as string);
}

const ADMIN_TOKEN = tokenFor("ADMIN");
const RECRUITER_TOKEN = tokenFor("RECRUITER");
const SENIOR_TOKEN = tokenFor("SENIOR_RECRUITER");
const AUDITOR_TOKEN = tokenFor("AUDITOR");
const OTHER_ORG_ADMIN_TOKEN = tokenFor("ADMIN", "org-2", "user-9");

const app = buildApp();

const BASE_CHECKLIST = [
  { item_code: "RETURN_LAPTOP", title: "Return laptop", category: "IT", default_due_days_from_exit: -3 },
  { item_code: "REVOKE_ACCESS", title: "Revoke system access", category: "IT", default_due_days_from_exit: 0 },
  { item_code: "FINAL_SETTLEMENT", title: "Final settlement", category: "Finance", default_due_days_from_exit: 7 },
];

beforeEach(() => {
  fake.state.employees.length = 0;
  fake.state.offboarding_templates.length = 0;
  fake.state.offboarding_cases.length = 0;
  fake.state.offboarding_steps.length = 0;
  fake.state.audit_log.length = 0;

  fake.state.employees.push({
    employee_id: "00000000-0000-0000-1000-000000000001",
    org_id: "org-1",
    full_name: "Karim Hossain",
    status: "ACTIVE",
  });
});

describe("POST /api/v1/offboarding/configure", () => {
  it("rejects non-admin/dept-head roles", async () => {
    const res = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ role: "Branch Officer", checklist: BASE_CHECKLIST });
    expect(res.status).toBe(403);
  });

  it("creates a new template as ADMIN", async () => {
    const res = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ role: "Branch Officer", checklist: BASE_CHECKLIST });

    expect(res.status).toBe(201);
    expect(res.body.template.role).toBe("Branch Officer");
    expect(res.body.template.checklist).toHaveLength(3);
    expect(fake.state.audit_log.some((a) => a.params.includes("OFFBOARDING_TEMPLATE_CREATED"))).toBe(true);
  });

  it("rejects a checklist with duplicate item_codes", async () => {
    const res = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        role: "Broken",
        checklist: [
          { item_code: "X", title: "A" },
          { item_code: "X", title: "B" },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("updates an existing template in place when template_id is supplied", async () => {
    const created = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ role: "Branch Officer", checklist: BASE_CHECKLIST });
    const templateId = created.body.template.template_id;

    const updated = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        template_id: templateId,
        role: "Senior Branch Officer",
        checklist: [{ item_code: "EXIT_INTERVIEW", title: "Exit interview", category: "HR" }],
      });

    expect(updated.status).toBe(200);
    expect(updated.body.template.template_id).toBe(templateId);
    expect(updated.body.template.role).toBe("Senior Branch Officer");
    expect(updated.body.template.checklist).toHaveLength(1);
    expect(fake.state.offboarding_templates).toHaveLength(1);
  });

  it("404s updating a template that belongs to a different org", async () => {
    const created = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ role: "Branch Officer", checklist: BASE_CHECKLIST });
    const templateId = created.body.template.template_id;

    const res = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${OTHER_ORG_ADMIN_TOKEN}`)
      .send({ template_id: templateId, role: "Hijacked", checklist: BASE_CHECKLIST });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/offboarding/start", () => {
  async function createTemplate() {
    const res = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ role: "Branch Officer", checklist: BASE_CHECKLIST });
    return res.body.template.template_id as string;
  }

  it("rejects non-staff roles", async () => {
    const templateId = await createTemplate();
    const res = await request(app)
      .post("/api/v1/offboarding/start")
      .set("Authorization", `Bearer ${AUDITOR_TOKEN}`)
      .send({ employee_id: "00000000-0000-0000-1000-000000000001", template_id: templateId, exit_date: "2026-09-30" });
    expect(res.status).toBe(403);
  });

  it("starts a case and expands the checklist into steps with computed due dates", async () => {
    const templateId = await createTemplate();
    const res = await request(app)
      .post("/api/v1/offboarding/start")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ employee_id: "00000000-0000-0000-1000-000000000001", template_id: templateId, exit_date: "2026-09-30" });

    expect(res.status).toBe(201);
    expect(res.body.case.status).toBe("ACTIVE");
    expect(res.body.case.exit_date).toBe("2026-09-30");
    expect(res.body.steps).toHaveLength(3);

    const laptop = res.body.steps.find((s: any) => s.item_code === "RETURN_LAPTOP");
    expect(laptop.due_date).toBe("2026-09-27T00:00:00.000Z");
    expect(laptop.status).toBe("PENDING");

    expect(fake.state.audit_log.some((a) => a.params.includes("OFFBOARDING_CASE_STARTED"))).toBe(true);
  });

  it("404s for an employee in a different org", async () => {
    const templateId = await createTemplate();
    const res = await request(app)
      .post("/api/v1/offboarding/start")
      .set("Authorization", `Bearer ${OTHER_ORG_ADMIN_TOKEN}`)
      .send({ employee_id: "00000000-0000-0000-1000-000000000001", template_id: templateId, exit_date: "2026-09-30" });
    expect(res.status).toBe(404);
  });

  it("409s starting a second active case for the same employee", async () => {
    const templateId = await createTemplate();
    const first = await request(app)
      .post("/api/v1/offboarding/start")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ employee_id: "00000000-0000-0000-1000-000000000001", template_id: templateId, exit_date: "2026-09-30" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/offboarding/start")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ employee_id: "00000000-0000-0000-1000-000000000001", template_id: templateId, exit_date: "2026-10-15" });
    expect(second.status).toBe(409);
  });

  it("rejects a malformed exit_date at the validation layer", async () => {
    const templateId = await createTemplate();
    const res = await request(app)
      .post("/api/v1/offboarding/start")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ employee_id: "00000000-0000-0000-1000-000000000001", template_id: templateId, exit_date: "30-09-2026" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/offboarding/cases/:case_id", () => {
  async function startCase() {
    const template = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ role: "Branch Officer", checklist: BASE_CHECKLIST });
    const started = await request(app)
      .post("/api/v1/offboarding/start")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ employee_id: "00000000-0000-0000-1000-000000000001", template_id: template.body.template.template_id, exit_date: "2026-09-30" });
    return started.body.case.case_id as string;
  }

  it("returns the case with its steps for staff roles", async () => {
    const caseId = await startCase();
    const res = await request(app).get(`/api/v1/offboarding/cases/${caseId}`).set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.case.case_id).toBe(caseId);
    expect(res.body.step_count).toBe(3);
  });

  it("404s for a case in a different org", async () => {
    const caseId = await startCase();
    const res = await request(app)
      .get(`/api/v1/offboarding/cases/${caseId}`)
      .set("Authorization", `Bearer ${OTHER_ORG_ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("404s for a well-formed but nonexistent case_id", async () => {
    const res = await request(app)
      .get(`/api/v1/offboarding/cases/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/v1/offboarding/steps/:step_id", () => {
  async function startCaseAndGetSteps() {
    const template = await request(app)
      .post("/api/v1/offboarding/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ role: "Branch Officer", checklist: BASE_CHECKLIST });
    const started = await request(app)
      .post("/api/v1/offboarding/start")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ employee_id: "00000000-0000-0000-1000-000000000001", template_id: template.body.template.template_id, exit_date: "2026-09-30" });
    return { caseId: started.body.case.case_id as string, steps: started.body.steps as any[] };
  }

  it("rejects a COMPLETE with no reason", async () => {
    const { steps } = await startCaseAndGetSteps();
    const res = await request(app)
      .patch(`/api/v1/offboarding/steps/${steps[0].step_id}`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ action: "COMPLETE" });
    expect(res.status).toBe(400);
  });

  it("allows a RECRUITER to COMPLETE a step but not to APPROVE it", async () => {
    const { steps } = await startCaseAndGetSteps();
    const stepId = steps[0].step_id;

    const complete = await request(app)
      .patch(`/api/v1/offboarding/steps/${stepId}`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ action: "COMPLETE", reason: "Laptop returned and logged." });
    expect(complete.status).toBe(200);
    expect(complete.body.step.status).toBe("COMPLETED");

    const approve = await request(app)
      .patch(`/api/v1/offboarding/steps/${stepId}`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ action: "APPROVE", reason: "Confirmed in IT asset register." });
    expect(approve.status).toBe(403);
  });

  it("rejects APPROVE on a step that has not been COMPLETED yet", async () => {
    const { steps } = await startCaseAndGetSteps();
    const res = await request(app)
      .patch(`/api/v1/offboarding/steps/${steps[0].step_id}`)
      .set("Authorization", `Bearer ${SENIOR_TOKEN}`)
      .send({ action: "APPROVE", reason: "Looks fine." });
    expect(res.status).toBe(409);
  });

  it("full lifecycle: COMPLETE then APPROVE, with audit entries and mandatory reasons persisted", async () => {
    const { steps } = await startCaseAndGetSteps();
    const stepId = steps[0].step_id;

    const complete = await request(app)
      .patch(`/api/v1/offboarding/steps/${stepId}`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ action: "COMPLETE", reason: "Laptop returned and logged." });
    expect(complete.status).toBe(200);

    const approve = await request(app)
      .patch(`/api/v1/offboarding/steps/${stepId}`)
      .set("Authorization", `Bearer ${SENIOR_TOKEN}`)
      .send({ action: "APPROVE", reason: "Confirmed in IT asset register." });
    expect(approve.status).toBe(200);
    expect(approve.body.step.status).toBe("APPROVED");
    expect(approve.body.step.approval_reason).toBe("Confirmed in IT asset register.");
    expect(approve.body.step.approved_by).toBe("user-1");
    expect(approve.body.case_completed).toBe(false); // 2 other steps still PENDING

    expect(fake.state.audit_log.some((a) => a.params.includes("OFFBOARDING_STEP_COMPLETED"))).toBe(true);
    expect(fake.state.audit_log.some((a) => a.params.includes("OFFBOARDING_STEP_APPROVED"))).toBe(true);
  });

  it("rejects a REJECT with no reason, and REJECTED steps can be re-completed", async () => {
    const { steps } = await startCaseAndGetSteps();
    const stepId = steps[0].step_id;

    await request(app)
      .patch(`/api/v1/offboarding/steps/${stepId}`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ action: "COMPLETE", reason: "Returned." });

    const rejectNoReason = await request(app)
      .patch(`/api/v1/offboarding/steps/${stepId}`)
      .set("Authorization", `Bearer ${SENIOR_TOKEN}`)
      .send({ action: "REJECT" });
    expect(rejectNoReason.status).toBe(400);

    const reject = await request(app)
      .patch(`/api/v1/offboarding/steps/${stepId}`)
      .set("Authorization", `Bearer ${SENIOR_TOKEN}`)
      .send({ action: "REJECT", reason: "Serial number does not match asset register." });
    expect(reject.status).toBe(200);
    expect(reject.body.step.status).toBe("REJECTED");

    const recomplete = await request(app)
      .patch(`/api/v1/offboarding/steps/${stepId}`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ action: "COMPLETE", reason: "Corrected serial number, re-verified." });
    expect(recomplete.status).toBe(200);
    expect(recomplete.body.step.status).toBe("COMPLETED");
  });

  it("closes the case and marks the employee OFFBOARDED once every step is APPROVED", async () => {
    const { caseId, steps } = await startCaseAndGetSteps();

    for (const step of steps) {
      const complete = await request(app)
        .patch(`/api/v1/offboarding/steps/${step.step_id}`)
        .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
        .send({ action: "COMPLETE", reason: `${step.title} done.` });
      expect(complete.status).toBe(200);
    }

    let lastApprove;
    for (const step of steps) {
      lastApprove = await request(app)
        .patch(`/api/v1/offboarding/steps/${step.step_id}`)
        .set("Authorization", `Bearer ${SENIOR_TOKEN}`)
        .send({ action: "APPROVE", reason: `${step.title} verified.` });
      expect(lastApprove.status).toBe(200);
    }

    expect(lastApprove!.body.case_completed).toBe(true);

    const employee = fake.state.employees.find((e) => e.employee_id === "00000000-0000-0000-1000-000000000001");
    expect(employee.status).toBe("OFFBOARDED");

    const caseRow = fake.state.offboarding_cases.find((c) => c.case_id === caseId);
    expect(caseRow.status).toBe("COMPLETED");

    expect(fake.state.audit_log.some((a) => a.params.includes("OFFBOARDING_CASE_COMPLETED"))).toBe(true);
  });

  it("404s for a step scoped to a different org", async () => {
    const { steps } = await startCaseAndGetSteps();
    const res = await request(app)
      .patch(`/api/v1/offboarding/steps/${steps[0].step_id}`)
      .set("Authorization", `Bearer ${OTHER_ORG_ADMIN_TOKEN}`)
      .send({ action: "COMPLETE", reason: "Trying to touch another org's step." });
    expect(res.status).toBe(404);
  });
});
