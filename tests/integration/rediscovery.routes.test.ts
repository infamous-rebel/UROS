import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeRediscoveryDb } from "../helpers/fake_rediscovery_db";

const fake = createFakeRediscoveryDb();

jest.mock("../../src/database/client", () => ({ db: fake.db }));

// Imported after the mock is registered so every module that pulls in
// database/client (agent, routes, dimension_scoring_agent, persona_agent,
// communication_agent, audit_helper) gets the fake.
import rediscoveryRoutes from "../../src/api/routes/rediscovery.routes";
import { errorHandler } from "../../src/api/middleware/error_handler";
import { generateConsentToken } from "../../src/agents/rediscovery_agent";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/rediscovery", rediscoveryRoutes);
  app.use(errorHandler);
  return app;
}

function tokenFor(role: string, orgId = "org-1", userId = "user-1"): string {
  return jwt.sign({ user_id: userId, org_id: orgId, role }, process.env.JWT_SECRET as string);
}

const ADMIN_TOKEN = tokenFor("ADMIN");
const SENIOR_RECRUITER_TOKEN = tokenFor("SENIOR_RECRUITER");
const RECRUITER_TOKEN = tokenFor("RECRUITER");
const AUDITOR_TOKEN = tokenFor("AUDITOR");

const ORG_ID = "org-1";
const PERSONA_ID = "11111111-1111-1111-1111-111111111111";

function resetState() {
  fake.state.organizations.length = 0;
  fake.state.candidates.length = 0;
  fake.state.candidate_academic_records.length = 0;
  fake.state.candidate_experience.length = 0;
  fake.state.candidate_quota.length = 0;
  fake.state.candidate_documents.length = 0;
  fake.state.personas.length = 0;
  fake.state.persona_requirements.length = 0;
  fake.state.fraud_flags.length = 0;
  fake.state.rediscovery_consents.length = 0;
  fake.state.rediscovery_suggestions.length = 0;
  fake.state.rediscovery_outreach.length = 0;
  fake.state.communication_log.length = 0;
  fake.state.audit_log.length = 0;

  fake.state.organizations.push({ org_id: ORG_ID, default_language: "en" });

  fake.state.personas.push({ persona_id: PERSONA_ID, org_id: ORG_ID, name: "Relationship Manager", active: true });
  fake.state.persona_requirements.push(
    { requirement_id: "req-1", persona_id: PERSONA_ID, field_path: "highest_cgpa", operator: "GTE", value: 3.0, weight: 60 },
    { requirement_id: "req-2", persona_id: PERSONA_ID, field_path: "total_experience_years", operator: "GTE", value: 1, weight: 40 }
  );
}

function addCandidate(id: string, overrides: Record<string, any> = {}) {
  fake.state.candidates.push({
    candidate_id: id,
    org_id: ORG_ID,
    full_name: `Candidate ${id}`,
    date_of_birth: "1995-01-01",
    status: "REJECTED",
    updated_at: "2026-01-01T00:00:00.000Z",
    job_circular_id: "CIRC-OLD",
    position_applied: "Officer",
    preferred_language: null,
    ...overrides,
  });
  fake.state.candidate_academic_records.push({
    candidate_id: id,
    level: "bachelor",
    cgpa: overrides.cgpa ?? 3.5,
    division_class: "First",
    passing_year: 2018,
    institution: "Dhaka University",
    board_or_university: "Dhaka University",
    result_scale: "out of 4",
    field_confidence: 1,
  });
  fake.state.candidate_experience.push({
    candidate_id: id,
    is_current: false,
    experience_years: overrides.experience_years ?? 2,
  });
}

beforeEach(() => {
  resetState();
});

describe("POST /api/v1/rediscovery/consent", () => {
  it("staff can record consent on a candidate's behalf", async () => {
    addCandidate("C1");
    const res = await request(buildApp())
      .post("/api/v1/rediscovery/consent")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ candidate_id: "C1", opted_in: true });
    expect(res.status).toBe(200);
    expect(res.body.consent.opted_in).toBe(true);
    expect(res.body.consent.opted_in_at).not.toBeNull();
  });

  it("rejects staff consent recording for a role outside STAFF_ROLES", async () => {
    addCandidate("C1");
    const res = await request(buildApp())
      .post("/api/v1/rediscovery/consent")
      .set("Authorization", `Bearer ${AUDITOR_TOKEN}`)
      .send({ candidate_id: "C1", opted_in: true });
    expect(res.status).toBe(403);
  });

  it("a candidate can opt out via their own public token, without any auth header", async () => {
    addCandidate("C1");
    const token = generateConsentToken("C1");
    const res = await request(buildApp())
      .post("/api/v1/rediscovery/consent")
      .send({ candidate_id: "C1", opted_in: false, token });
    expect(res.status).toBe(200);
    expect(res.body.consent.opted_in).toBe(false);
    expect(res.body.consent.opted_out_at).not.toBeNull();
  });

  it("rejects a public request with a wrong or missing token", async () => {
    addCandidate("C1");
    const wrongToken = generateConsentToken("SOMEONE-ELSE");
    const res = await request(buildApp())
      .post("/api/v1/rediscovery/consent")
      .send({ candidate_id: "C1", opted_in: true, token: wrongToken });
    expect(res.status).toBe(404);

    const noToken = await request(buildApp())
      .post("/api/v1/rediscovery/consent")
      .send({ candidate_id: "C1", opted_in: true });
    expect(noToken.status).toBe(404);
  });

  it("upserts the same consent row rather than duplicating it", async () => {
    addCandidate("C1");
    const app = buildApp();
    await request(app).post("/api/v1/rediscovery/consent").set("Authorization", `Bearer ${ADMIN_TOKEN}`).send({ candidate_id: "C1", opted_in: true });
    await request(app).post("/api/v1/rediscovery/consent").set("Authorization", `Bearer ${ADMIN_TOKEN}`).send({ candidate_id: "C1", opted_in: false });
    expect(fake.state.rediscovery_consents.filter((c) => c.candidate_id === "C1")).toHaveLength(1);
    expect(fake.state.rediscovery_consents[0].opted_in).toBe(false);
  });
});

describe("GET /api/v1/rediscovery/consent/:candidate_id", () => {
  it("returns NO_RECORD when nothing has ever been recorded", async () => {
    addCandidate("C1");
    const res = await request(buildApp()).get("/api/v1/rediscovery/consent/C1").set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("NO_RECORD");
    expect(res.body.consent).toBeNull();
  });

  it("returns the recorded status after opt-in", async () => {
    addCandidate("C1");
    const app = buildApp();
    await request(app).post("/api/v1/rediscovery/consent").set("Authorization", `Bearer ${ADMIN_TOKEN}`).send({ candidate_id: "C1", opted_in: true });
    const res = await request(app).get("/api/v1/rediscovery/consent/C1").set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OPTED_IN");
  });
});

describe("POST /api/v1/rediscovery/run", () => {
  it("creates a suggestion for an eligible, well-matched, opted-in candidate", async () => {
    addCandidate("MATCH1", { cgpa: 3.8, experience_years: 3 });
    fake.state.rediscovery_consents.push({
      consent_id: "consent-seed-1",
      candidate_id: "MATCH1",
      org_id: ORG_ID,
      opted_in: true,
      opted_in_at: "2026-01-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(buildApp())
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ target_circular_id: "BSC-2027-01", target_position: "Senior Officer", persona_id: PERSONA_ID });

    expect(res.status).toBe(200);
    expect(res.body.candidates_considered).toBe(1);
    expect(res.body.suggestions_created).toHaveLength(1);
    const suggestion = res.body.suggestions_created[0];
    expect(suggestion.candidate_id).toBe("MATCH1");
    expect(suggestion.status).toBe("PENDING_REVIEW");
    expect(suggestion.reason_code).toBe("REDISCOVERY_MATCH_SUGGESTED");
    expect(suggestion.fit_score).toBe(100);
    expect(suggestion.evidence.consent_status).toBe("OPTED_IN");
  });

  it("excludes candidates without opt-in when require_opt_in defaults to true", async () => {
    addCandidate("NOCONSENT", { cgpa: 3.8, experience_years: 3 });

    const res = await request(buildApp())
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ target_circular_id: "BSC-2027-01", persona_id: PERSONA_ID });

    expect(res.status).toBe(200);
    expect(res.body.candidates_excluded_consent).toBe(1);
    expect(res.body.suggestions_created).toHaveLength(0);
  });

  it("excludes candidates with an open fraud flag even when opted in", async () => {
    addCandidate("FRAUDY", { cgpa: 3.8, experience_years: 3 });
    fake.state.rediscovery_consents.push({
      consent_id: "consent-seed-2",
      candidate_id: "FRAUDY",
      org_id: ORG_ID,
      opted_in: true,
      opted_in_at: "2026-01-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    fake.state.fraud_flags.push({ candidate_id: "FRAUDY", org_id: ORG_ID, status: "CONFIRMED" });

    const res = await request(buildApp())
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ target_circular_id: "BSC-2027-01", persona_id: PERSONA_ID });

    expect(res.status).toBe(200);
    expect(res.body.candidates_excluded_fraud).toBe(1);
    expect(res.body.suggestions_created).toHaveLength(0);
  });

  it("excludes candidates below the min_fit_score threshold without creating a suggestion row", async () => {
    addCandidate("WEAK", { cgpa: 2.5, experience_years: 0 });
    fake.state.rediscovery_consents.push({
      consent_id: "consent-seed-3",
      candidate_id: "WEAK",
      org_id: ORG_ID,
      opted_in: true,
      opted_in_at: "2026-01-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(buildApp())
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ target_circular_id: "BSC-2027-01", persona_id: PERSONA_ID, min_fit_score: 50 });

    expect(res.status).toBe(200);
    expect(res.body.candidates_below_threshold).toBe(1);
    expect(res.body.suggestions_created).toHaveLength(0);
  });

  it("is idempotent: rerunning the same circular does not duplicate a suggestion", async () => {
    addCandidate("MATCH2", { cgpa: 3.8, experience_years: 3 });
    fake.state.rediscovery_consents.push({
      consent_id: "consent-seed-4",
      candidate_id: "MATCH2",
      org_id: ORG_ID,
      opted_in: true,
      opted_in_at: "2026-01-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const app = buildApp();
    const body = { target_circular_id: "BSC-2027-01", persona_id: PERSONA_ID };
    const first = await request(app).post("/api/v1/rediscovery/run").set("Authorization", `Bearer ${ADMIN_TOKEN}`).send(body);
    const second = await request(app).post("/api/v1/rediscovery/run").set("Authorization", `Bearer ${ADMIN_TOKEN}`).send(body);

    expect(first.body.suggestions_created).toHaveLength(1);
    expect(second.body.suggestions_created).toHaveLength(0);
    expect(second.body.candidates_excluded_already_suggested).toBe(1);
    expect(fake.state.rediscovery_suggestions).toHaveLength(1);
  });

  it("rejects RECRUITER (not ADMIN/SENIOR_RECRUITER) from running matching", async () => {
    const res = await request(buildApp())
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ target_circular_id: "BSC-2027-01", persona_id: PERSONA_ID });
    expect(res.status).toBe(403);
  });

  it("allows SENIOR_RECRUITER to run matching", async () => {
    addCandidate("MATCH3", { cgpa: 3.8, experience_years: 3 });
    fake.state.rediscovery_consents.push({
      consent_id: "c5",
      candidate_id: "MATCH3",
      org_id: ORG_ID,
      opted_in: true,
      opted_in_at: "2026-01-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await request(buildApp())
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${SENIOR_RECRUITER_TOKEN}`)
      .send({ target_circular_id: "BSC-2027-02", persona_id: PERSONA_ID });
    expect(res.status).toBe(200);
    expect(res.body.suggestions_created).toHaveLength(1);
  });

  it("returns 404 for a persona that does not exist in this org", async () => {
    const res = await request(buildApp())
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ target_circular_id: "BSC-2027-01", persona_id: "99999999-9999-9999-9999-999999999999" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/rediscovery/suggestions and PATCH review", () => {
  async function seedOneSuggestion(app: express.Express) {
    addCandidate("MATCH1", { cgpa: 3.8, experience_years: 3 });
    fake.state.rediscovery_consents.push({
      consent_id: "c1",
      candidate_id: "MATCH1",
      org_id: ORG_ID,
      opted_in: true,
      opted_in_at: "2026-01-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const runRes = await request(app)
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ target_circular_id: "BSC-2027-01", persona_id: PERSONA_ID });
    return runRes.body.suggestions_created[0].suggestion_id as string;
  }

  it("lists suggestions for the org", async () => {
    const app = buildApp();
    await seedOneSuggestion(app);
    const res = await request(app).get("/api/v1/rediscovery/suggestions").set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
  });

  it("approving requires a mandatory, non-empty reason", async () => {
    const app = buildApp();
    const suggestionId = await seedOneSuggestion(app);
    const res = await request(app)
      .patch(`/api/v1/rediscovery/suggestions/${suggestionId}`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ action: "APPROVE", reason: "" });
    expect(res.status).toBe(400);
  });

  it("approves a suggestion with a reason", async () => {
    const app = buildApp();
    const suggestionId = await seedOneSuggestion(app);
    const res = await request(app)
      .patch(`/api/v1/rediscovery/suggestions/${suggestionId}`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ action: "APPROVE", reason: "Strong fit, worth re-inviting for the new circular." });
    expect(res.status).toBe(200);
    expect(res.body.suggestion.status).toBe("APPROVED");
    expect(res.body.suggestion.reviewed_by).toBe("user-1");
  });

  it("cannot review the same suggestion twice", async () => {
    const app = buildApp();
    const suggestionId = await seedOneSuggestion(app);
    await request(app)
      .patch(`/api/v1/rediscovery/suggestions/${suggestionId}`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ action: "APPROVE", reason: "First review." });
    const second = await request(app)
      .patch(`/api/v1/rediscovery/suggestions/${suggestionId}`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ action: "REJECT", reason: "Trying again." });
    expect(second.status).toBe(409);
  });
});

describe("POST /api/v1/rediscovery/outreach and GET history", () => {
  async function seedApprovedSuggestion(app: express.Express, candidateId = "MATCH1") {
    addCandidate(candidateId, { cgpa: 3.8, experience_years: 3 });
    fake.state.rediscovery_consents.push({
      consent_id: `c-${candidateId}`,
      candidate_id: candidateId,
      org_id: ORG_ID,
      opted_in: true,
      opted_in_at: "2026-01-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const runRes = await request(app)
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ target_circular_id: `CIRC-${candidateId}`, persona_id: PERSONA_ID });
    const suggestionId = runRes.body.suggestions_created[0].suggestion_id as string;
    await request(app)
      .patch(`/api/v1/rediscovery/suggestions/${suggestionId}`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ action: "APPROVE", reason: "Good fit." });
    return suggestionId;
  }

  it("sends outreach for an approved suggestion via the Communication Hub and records rediscovery_outreach", async () => {
    const app = buildApp();
    const suggestionId = await seedApprovedSuggestion(app, "MATCH1");

    const res = await request(app)
      .post("/api/v1/rediscovery/outreach")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ suggestion_ids: [suggestionId], channel: "SMS", template_code: "REDISCOVERY_INVITE" });

    expect(res.status).toBe(200);
    expect(res.body.sent).toHaveLength(1);
    expect(res.body.skipped).toHaveLength(0);
    expect(fake.state.communication_log).toHaveLength(1);
    expect(fake.state.communication_log[0].candidate_id).toBe("MATCH1");
    expect(fake.state.rediscovery_outreach).toHaveLength(1);
    expect(fake.state.rediscovery_outreach[0].response_status).toBe("PENDING");
  });

  it("skips a suggestion that is not APPROVED", async () => {
    const app = buildApp();
    addCandidate("PENDING1", { cgpa: 3.8, experience_years: 3 });
    fake.state.rediscovery_consents.push({
      consent_id: "c-pending1",
      candidate_id: "PENDING1",
      org_id: ORG_ID,
      opted_in: true,
      opted_in_at: "2026-01-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const runRes = await request(app)
      .post("/api/v1/rediscovery/run")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ target_circular_id: "CIRC-PENDING1", persona_id: PERSONA_ID });
    const suggestionId = runRes.body.suggestions_created[0].suggestion_id as string;

    const res = await request(app)
      .post("/api/v1/rediscovery/outreach")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ suggestion_ids: [suggestionId], channel: "SMS", template_code: "REDISCOVERY_INVITE" });

    expect(res.status).toBe(200);
    expect(res.body.sent).toHaveLength(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].reason).toMatch(/not APPROVED/);
  });

  it("skips an approved suggestion whose candidate withdrew consent before send time", async () => {
    const app = buildApp();
    const suggestionId = await seedApprovedSuggestion(app, "MATCH2");
    // Candidate withdraws consent after approval but before outreach is sent.
    await request(app)
      .post("/api/v1/rediscovery/consent")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ candidate_id: "MATCH2", opted_in: false });

    const res = await request(app)
      .post("/api/v1/rediscovery/outreach")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ suggestion_ids: [suggestionId], channel: "SMS", template_code: "REDISCOVERY_INVITE" });

    expect(res.status).toBe(200);
    expect(res.body.sent).toHaveLength(0);
    expect(res.body.skipped[0].reason).toMatch(/not opted in/);
    expect(fake.state.communication_log).toHaveLength(0);
  });

  it("lists sent outreach history for the org", async () => {
    const app = buildApp();
    const suggestionId = await seedApprovedSuggestion(app, "MATCH3");
    await request(app)
      .post("/api/v1/rediscovery/outreach")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ suggestion_ids: [suggestionId], channel: "EMAIL", template_code: "REDISCOVERY_INVITE" });

    const res = await request(app).get("/api/v1/rediscovery/outreach").set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.outreach).toHaveLength(1);
    expect(res.body.outreach[0].candidate_id).toBe("MATCH3");
    expect(res.body.outreach[0].channel).toBe("EMAIL");
  });
});
