import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createFakeReferenceDb } from "../helpers/fake_reference_db";

const fake = createFakeReferenceDb();

jest.mock("../../src/database/client", () => ({ db: fake.db }));

jest.mock("../../src/services/integrations/email", () => ({
  sendOutboundEmail: jest.fn(async (_orgId: string, recipient: { candidate_id: string }) => ({
    candidate_id: recipient.candidate_id,
    status: "SENT",
  })),
}));

jest.mock("../../src/services/integrations/whatsapp_business", () => ({
  sendTemplateMessage: jest.fn(async (_orgId: string, recipient: { candidate_id: string }) => ({
    candidate_id: recipient.candidate_id,
    status: "SENT",
  })),
}));

// Imported after the mocks are registered so every module that pulls in
// database/client / email / whatsapp_business (agent, routes, audit_helper)
// gets the fakes.
import referenceRoutes from "../../src/api/routes/reference.routes";
import { errorHandler } from "../../src/api/middleware/error_handler";
import { sendOutboundEmail } from "../../src/services/integrations/email";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/references", referenceRoutes);
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
  jest.clearAllMocks();
  fake.state.candidates.length = 0;
  fake.state.reference_question_sets.length = 0;
  fake.state.reference_requests.length = 0;
  fake.state.reference_responses.length = 0;
  fake.state.reference_results.length = 0;
  fake.state.audit_log.length = 0;

  fake.state.candidates.push({ candidate_id: "UROS-TEST-0001", org_id: "org-1", full_name: "Candidate One" });
});

const app = buildApp();

describe("POST /api/v1/references/configure", () => {
  it("rejects non-admin/dept-head roles", async () => {
    const res = await request(app)
      .post("/api/v1/references/configure")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ name: "Custom", questions: [{ question_id: "q1", text: "Rate?", type: "RATING_1_5", weight: 100 }] });
    expect(res.status).toBe(403);
  });

  it("creates an active question set as ADMIN and versions a prior active one on reconfigure", async () => {
    const first = await request(app)
      .post("/api/v1/references/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ name: "Org Default v1", questions: [{ question_id: "q1", text: "Rate?", type: "RATING_1_5", weight: 100 }] });
    expect(first.status).toBe(201);
    expect(first.body.question_set.version).toBe(1);
    expect(first.body.question_set.active).toBe(true);

    const second = await request(app)
      .post("/api/v1/references/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ name: "Org Default v2", questions: [{ question_id: "q1", text: "Rate?", type: "RATING_1_5", weight: 100 }] });
    expect(second.status).toBe(201);
    expect(second.body.question_set.version).toBe(2);

    const activeRows = fake.state.reference_question_sets.filter((q) => q.org_id === "org-1" && q.persona_id === null && q.active);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].name).toBe("Org Default v2");
    expect(fake.state.audit_log.some((a) => a.params.includes("REFERENCE_QUESTION_SET_CONFIGURED"))).toBe(true);
  });

  it("rejects a question set with duplicate question_ids", async () => {
    const res = await request(app)
      .post("/api/v1/references/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({
        name: "Broken",
        questions: [
          { question_id: "q1", text: "A", type: "RATING_1_5", weight: 50 },
          { question_id: "q1", text: "B", type: "YES_NO", weight: 50 },
        ],
      });
    expect(res.status).toBe(500); // agent throws a generic Error, mapped by the default error handler
  });

  it("rejects an empty questions array", async () => {
    const res = await request(app)
      .post("/api/v1/references/configure")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ name: "Empty", questions: [] });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/references/request", () => {
  it("404s for a candidate not in the caller's org", async () => {
    const res = await request(app)
      .post("/api/v1/references/request")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ candidate_id: "NOT-A-CANDIDATE", referee_email: "ref@example.com" });
    expect(res.status).toBe(404);
  });

  it("rejects a request with neither referee_email nor referee_phone", async () => {
    const res = await request(app)
      .post("/api/v1/references/request")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ candidate_id: "UROS-TEST-0001" });
    expect(res.status).toBe(400);
  });

  it("creates and sends a request via email, falling back to the system default question set", async () => {
    const res = await request(app)
      .post("/api/v1/references/request")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ candidate_id: "UROS-TEST-0001", referee_email: "referee@example.com" });

    expect(res.status).toBe(201);
    expect(res.body.request.status).toBe("SENT");
    expect(typeof res.body.respond_token).toBe("string");
    expect(res.body.respond_token).toHaveLength(64);
    expect(sendOutboundEmail).toHaveBeenCalledTimes(1);

    // Token is never persisted in plaintext.
    const stored = fake.state.reference_requests[0];
    expect(stored.token).not.toBe(res.body.respond_token);

    expect(fake.state.audit_log.some((a) => a.params.includes("REFERENCE_REQUEST_SENT"))).toBe(true);
  });

  it("returns 502 and leaves the request unsent when delivery fails", async () => {
    (sendOutboundEmail as jest.Mock).mockResolvedValueOnce({ candidate_id: "UROS-TEST-0001", status: "FAILED", last_error: "boom" });

    const res = await request(app)
      .post("/api/v1/references/request")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ candidate_id: "UROS-TEST-0001", referee_email: "referee@example.com" });

    expect(res.status).toBe(502);
    expect(fake.state.reference_requests[0].status).toBe("PENDING");
    expect(fake.state.audit_log.some((a) => a.params.includes("REFERENCE_REQUEST_SEND_FAILED"))).toBe(true);
  });
});

describe("full flow: request -> respond -> score -> review", () => {
  async function seedSentRequest() {
    const res = await request(app)
      .post("/api/v1/references/request")
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ candidate_id: "UROS-TEST-0001", referee_email: "referee@example.com" });
    return { requestId: res.body.request.request_id as string, token: res.body.respond_token as string };
  }

  it("lists the request via GET /requests/:candidate_id", async () => {
    await seedSentRequest();
    const res = await request(app)
      .get("/api/v1/references/requests/UROS-TEST-0001")
      .set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.requests[0].status).toBe("SENT");
  });

  it("accepts a referee's responses via the public token endpoint", async () => {
    const { token } = await seedSentRequest();
    const res = await request(app)
      .post(`/api/v1/references/respond/${token}`)
      .send({
        answers: [
          { question_id: "q_overall_performance", response_text: "5" },
          { question_id: "q_reliability", response_text: "4" },
          { question_id: "q_teamwork", response_text: "4" },
          { question_id: "q_would_rehire", response_text: "YES" },
          { question_id: "q_comments", response_text: "Excellent colleague." },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(fake.state.audit_log.some((a) => a.params.includes("REFERENCE_RESPONSE_RECEIVED"))).toBe(true);
  });

  it("rejects an unknown token with a generic 404", async () => {
    const res = await request(app)
      .post(`/api/v1/references/respond/${"a".repeat(64)}`)
      .send({ answers: [{ question_id: "q1", response_text: "5" }] });
    expect(res.status).toBe(404);
  });

  it("rejects a second submission against an already-completed request (one-time use)", async () => {
    const { token } = await seedSentRequest();
    const answers = [
      { question_id: "q_overall_performance", response_text: "5" },
      { question_id: "q_reliability", response_text: "4" },
      { question_id: "q_teamwork", response_text: "4" },
      { question_id: "q_would_rehire", response_text: "YES" },
      { question_id: "q_comments", response_text: "Great." },
    ];
    const first = await request(app).post(`/api/v1/references/respond/${token}`).send({ answers });
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/v1/references/respond/${token}`).send({ answers });
    expect(second.status).toBe(404);
  });

  it("409s a score attempt before responses are received", async () => {
    const { requestId } = await seedSentRequest();
    const res = await request(app)
      .post(`/api/v1/references/requests/${requestId}/score`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(res.status).toBe(409);
  });

  it("scores a completed request end-to-end and produces a RECOMMEND result with full evidence", async () => {
    const { requestId, token } = await seedSentRequest();
    await request(app)
      .post(`/api/v1/references/respond/${token}`)
      .send({
        answers: [
          { question_id: "q_overall_performance", response_text: "5" },
          { question_id: "q_reliability", response_text: "5" },
          { question_id: "q_teamwork", response_text: "5" },
          { question_id: "q_would_rehire", response_text: "YES" },
          { question_id: "q_comments", response_text: "Outstanding." },
        ],
      });

    const scoreRes = await request(app)
      .post(`/api/v1/references/requests/${requestId}/score`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`);

    expect(scoreRes.status).toBe(200);
    expect(scoreRes.body.result.recommendation).toBe("RECOMMEND");
    expect(scoreRes.body.result.max_score).toBe(100);
    expect(scoreRes.body.result.reason_code).toBe("REFERENCE_SCORE_ABOVE_THRESHOLD");
    expect(fake.state.audit_log.some((a) => a.params.includes("REFERENCE_SCORING_COMPLETED"))).toBe(true);

    // GET list reflects the joined score/recommendation.
    const listRes = await request(app)
      .get("/api/v1/references/requests/UROS-TEST-0001")
      .set("Authorization", `Bearer ${AUDITOR_TOKEN}`);
    expect(listRes.body.requests[0].recommendation).toBe("RECOMMEND");
  });

  it("requires a mandatory review_reason on PATCH review", async () => {
    const { requestId, token } = await seedSentRequest();
    await request(app)
      .post(`/api/v1/references/respond/${token}`)
      .send({
        answers: [
          { question_id: "q_overall_performance", response_text: "5" },
          { question_id: "q_reliability", response_text: "5" },
          { question_id: "q_teamwork", response_text: "5" },
          { question_id: "q_would_rehire", response_text: "YES" },
          { question_id: "q_comments", response_text: "Great." },
        ],
      });
    const scoreRes = await request(app)
      .post(`/api/v1/references/requests/${requestId}/score`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`);

    const res = await request(app)
      .patch(`/api/v1/references/results/${scoreRes.body.result.result_id}`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`)
      .send({ review_decision: "APPROVED" });
    expect(res.status).toBe(400);
  });

  it("finalizes a result with a human review decision and reason, never overwritten by re-scoring", async () => {
    const { requestId, token } = await seedSentRequest();
    await request(app)
      .post(`/api/v1/references/respond/${token}`)
      .send({
        answers: [
          { question_id: "q_overall_performance", response_text: "2" },
          { question_id: "q_reliability", response_text: "2" },
          { question_id: "q_teamwork", response_text: "2" },
          { question_id: "q_would_rehire", response_text: "NO" },
          { question_id: "q_comments", response_text: "Concerns raised." },
        ],
      });
    const scoreRes = await request(app)
      .post(`/api/v1/references/requests/${requestId}/score`)
      .set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    expect(scoreRes.body.result.recommendation).toBe("CONCERN");

    const resultId = scoreRes.body.result.result_id;
    const reviewRes = await request(app)
      .patch(`/api/v1/references/results/${resultId}`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ review_decision: "ESCALATED", review_reason: "Concerning score; escalating to senior recruiter." });

    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.result.review_decision).toBe("ESCALATED");
    expect(reviewRes.body.result.review_reason).toBe("Concerning score; escalating to senior recruiter.");
    expect(fake.state.audit_log.some((a) => a.params.includes("REFERENCE_RESULT_ESCALATED"))).toBe(true);

    // Re-scoring must not wipe the human decision.
    await request(app).post(`/api/v1/references/requests/${requestId}/score`).set("Authorization", `Bearer ${RECRUITER_TOKEN}`);
    const stillReviewed = fake.state.reference_results.find((r) => r.result_id === resultId);
    expect(stillReviewed.review_decision).toBe("ESCALATED");
  });

  it("404s a review of an unknown result id", async () => {
    const res = await request(app)
      .patch(`/api/v1/references/results/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ review_decision: "APPROVED", review_reason: "x" });
    expect(res.status).toBe(404);
  });
});
