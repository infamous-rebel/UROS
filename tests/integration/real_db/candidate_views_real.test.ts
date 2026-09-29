/**
 * Quest 05 Part 4 — Real-DB verification for CandidateList + CandidateInspector.
 *
 * Tests:
 * 1. Loads a list of candidates with filters applied (status, search)
 * 2. Opens one candidate's inspector (GET /candidates/:id)
 * 3. Shows at least one rule result with a reason code and evidence
 * 4. Executes an action (add note) and confirms it is audit-logged
 * 5. PATCH status override with audit trail verification
 *
 * Uses a real Postgres database (uros_part4_test) with migrations + seed data.
 */
import { Pool } from "pg";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_part4_test";
const BASE_URL = process.env.DATABASE_URL_TEST ?? "postgres://uros:uros@localhost:5443/uros";
const TEST_URL = BASE_URL.replace(/\/[^/]+$/, `/${REAL_DB}`);

process.env.DATABASE_URL = TEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

import { createApp } from "../../../src/api/server";
import { hashPassword } from "../../../src/services/auth/password";
import { pool as dbPool } from "../../../src/database/client";

jest.setTimeout(30_000);

// ─── Constants ───────────────────────────────────────────────────────
const ORG_ID = "dddddddd-4444-4444-4444-444444444444";
const USER_ID = "eeeeeeee-4444-4444-4444-444444444444";
const CANDIDATE_1 = "cccccccc-4444-4444-4444-444444444401";
const CANDIDATE_2 = "cccccccc-4444-4444-4444-444444444402";
const CIRCULAR_ID = "bbbbbbbb-4444-4444-4444-444444444401";
const RULE_PACK_ID = "aaaaaaaa-4444-4444-4444-444444444401";
const RULE_PACK_VERSION_ID = "aaaaaaaa-4444-4444-4444-444444444402";
const RULE_ID = "aaaaaaaa-4444-4444-4444-444444444403";

const pool = new Pool({ connectionString: TEST_URL });
const app = createApp();

async function createTestDatabase(): Promise<void> {
  const adminPool = new Pool({ connectionString: BASE_URL });
  try {
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } catch { /* DB may not exist yet */ }
  await adminPool.query(`CREATE DATABASE ${REAL_DB}`);
  await adminPool.end();

  // Run migrations
  const migrationsDir = path.resolve(__dirname, "../../../src/database/migrations");
  const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
}

let accessToken: string;

beforeAll(async () => {
  await createTestDatabase();

  // Seed test data
  await pool.query(`INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, $2, $3, $4)`, [ORG_ID, "Part4 Test Org", "GOVT_NONCADRE", "CLOUD"]);
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
     VALUES ($1, $2, 'Part4 User', $3, 'ADMIN', $4, false, $2)`,
    [USER_ID, ORG_ID, "part4@test.com", await hashPassword("Test-Pass-123")]
  );
  // Two candidates with different statuses (job_circular_id is just a TEXT reference)
  await pool.query(
    `INSERT INTO candidates (candidate_id, org_id, full_name, status, source_platform, job_circular_id, position_applied, data_confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [CANDIDATE_1, ORG_ID, "Alice Test", "NEEDS_REVIEW", "bdjobs", CIRCULAR_ID, "Engineer", "High"]
  );
  await pool.query(
    `INSERT INTO candidates (candidate_id, org_id, full_name, status, source_platform, job_circular_id, position_applied, data_confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [CANDIDATE_2, ORG_ID, "Bob Test", "SCORED", "Teletalk", CIRCULAR_ID, "Manager", "Medium"]
  );

  // Evaluation result for candidate 1 with reason code and evidence
  // Need to create parent records: rule_pack -> rule_pack_version -> rule
  await pool.query(
    `INSERT INTO rule_packs (rule_pack_id, org_id, name, sector, is_active, created_by)
     VALUES ($1, $2, $3, $4, true, $5)`,
    [RULE_PACK_ID, ORG_ID, "Test Rules", "GOVT_NONCADRE", USER_ID]
  );
  await pool.query(
    `INSERT INTO rule_pack_versions (version_id, rule_pack_id, version_number, created_by)
     VALUES ($1, $2, 1, $3)`,
    [RULE_PACK_VERSION_ID, RULE_PACK_ID, USER_ID]
  );
  await pool.query(
    `INSERT INTO rules (rule_id, rule_pack_version_id, rule_code, rule_type, field_path, operator, threshold_value, fail_reason_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [RULE_ID, RULE_PACK_VERSION_ID, "rule_experience", "ELIGIBILITY", "years_experience", "GTE", JSON.stringify({ value: 5 }), "EXPERIENCE_MISMATCH"]
  );
  await pool.query(
    `INSERT INTO evaluation_results (candidate_id, org_id, rule_id, rule_pack_version_id, status, reason_code, confidence, distance_to_threshold, input_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      CANDIDATE_1, ORG_ID, RULE_ID, RULE_PACK_VERSION_ID, "FAIL", "EXPERIENCE_MISMATCH",
      0.85, -0.15, JSON.stringify({ years_exp: 2, required: 5, source: "resume_parser" }),
    ]
  );

  // Login to get access token
  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "part4@test.com", password: "Test-Pass-123" });
  expect(loginRes.status).toBe(200);
  accessToken = loginRes.body.access_token;
});

afterAll(async () => {
  await pool.end();
  await dbPool.end();
  const cleanupPool = new Pool({ connectionString: BASE_URL });
  try {
    await cleanupPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await cleanupPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } finally {
    await cleanupPool.end();
  }
});

describe("Quest 05 Part 4 — Candidate views (real DB)", () => {
  test("GET /candidates returns list with status filter", async () => {
    const res = await request(app)
      .get("/api/v1/candidates?status=NEEDS_REVIEW")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidates).toBeInstanceOf(Array);
    expect(res.body.candidates.length).toBeGreaterThanOrEqual(1);
    for (const c of res.body.candidates) {
      expect(c.status).toBe("NEEDS_REVIEW");
    }
  });

  test("GET /candidates with search filter returns matching candidates", async () => {
    const res = await request(app)
      .get("/api/v1/candidates?search=Alice")
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidates.length).toBe(1);
    expect(res.body.candidates[0].full_name).toBe("Alice Test");
  });

  test("GET /candidates/:id returns full detail with evaluation summary (reason code + evidence)", async () => {
    const res = await request(app)
      .get(`/api/v1/candidates/${CANDIDATE_1}`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidate).toBeDefined();
    expect(res.body.candidate.candidate_id).toBe(CANDIDATE_1);
    expect(res.body.candidate.full_name).toBe("Alice Test");

    // Evaluation summary should have at least one rule result
    expect(res.body.evaluation_summary).toBeInstanceOf(Array);
    expect(res.body.evaluation_summary.length).toBeGreaterThanOrEqual(1);

    const eval0 = res.body.evaluation_summary[0];
    expect(eval0.rule_id).toBe(RULE_ID);
    expect(eval0.status).toBe("FAIL");
    expect(eval0.reason_code).toBe("EXPERIENCE_MISMATCH");
    expect(Number(eval0.confidence)).toBeCloseTo(0.85);
    expect(Number(eval0.distance_to_threshold)).toBeCloseTo(-0.15);

    // Evidence data (input_value) should be present
    expect(eval0.input_value).toBeDefined();
    expect(eval0.input_value.years_exp).toBe(2);
    expect(eval0.input_value.required).toBe(5);
  });

  test("POST /candidates/:id/notes adds a note and creates an audit entry", async () => {
    // Add a note
    const noteRes = await request(app)
      .post(`/api/v1/candidates/${CANDIDATE_1}/notes`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ note: "Candidate has strong portfolio despite experience gap." });

    expect(noteRes.status).toBe(201);
    expect(noteRes.body.ok).toBe(true);
    expect(noteRes.body.candidate_id).toBe(CANDIDATE_1);

    // Verify the note is audit-logged
    const auditRes = await request(app)
      .get(`/api/v1/audit-logs?entity_type=CANDIDATE&entity_id=${CANDIDATE_1}`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(auditRes.status).toBe(200);
    expect(auditRes.body.entries).toBeInstanceOf(Array);
    expect(auditRes.body.entries.length).toBeGreaterThanOrEqual(1);

    const noteEntry = auditRes.body.entries.find(
      (e: { action: string; reason_comment: string }) =>
        e.action === "CANDIDATE_NOTE_ADDED" &&
        e.reason_comment === "Candidate has strong portfolio despite experience gap."
    );
    expect(noteEntry).toBeDefined();
    expect(noteEntry.entity_type).toBe("CANDIDATE");
    expect(noteEntry.entity_id).toBe(CANDIDATE_1);
    expect(noteEntry.agent_or_user).toBe(USER_ID);
  });

  test("PATCH /candidates/:id/status overrides status with audit trail", async () => {
    const res = await request(app)
      .patch(`/api/v1/candidates/${CANDIDATE_1}/status`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ status: "SCORED", correction_reason: "Manual override after review" });

    expect(res.status).toBe(200);
    expect(res.body.candidate.status).toBe("SCORED");

    // Verify audit trail
    const auditRes = await request(app)
      .get(`/api/v1/audit-logs?entity_type=CANDIDATE&entity_id=${CANDIDATE_1}`)
      .set("Authorization", `Bearer ${accessToken}`);

    const statusEntry = auditRes.body.entries.find(
      (e: { action: string }) => e.action === "CANDIDATE_STATUS_CHANGED"
    );
    expect(statusEntry).toBeDefined();
    expect(statusEntry.reason_comment).toBe("Manual override after review");
  });
});
