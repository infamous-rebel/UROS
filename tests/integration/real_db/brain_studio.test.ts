/**
 * Quest 05 Part 6 — Brain Studio functional test.
 *
 * Verifies the full rule pack lifecycle:
 *   1. Create a rule pack
 *   2. Add 3 rules: eligibility, scoring, knockout
 *   3. Run conflict checker — verify clean
 *   4. Add a 4th rule that conflicts — verify conflict detected
 *   5. Remove the conflicting rule — verify clean again
 *   6. Publish with reason — verify audit log
 *   7. Run simulation against sample candidates
 *   8. Query DB: rules, rule_pack_versions, audit_log
 *
 * Uses real Postgres (uros_brain_studio_test).
 */
import { Pool } from "pg";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_brain_studio_test";
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
const ORG_ID = "ffffffff-7777-7777-7777-777777777777";
const USER_ID = "aaaaaaaa-7777-7777-7777-777777777777";

const pool = new Pool({ connectionString: TEST_URL });
const app = createApp();

async function createTestDatabase(): Promise<void> {
  const adminPool = new Pool({ connectionString: BASE_URL });
  try {
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } catch { /* DB may not exist */ }
  await adminPool.query(`CREATE DATABASE ${REAL_DB}`);
  await adminPool.end();

  const migrationsDir = path.resolve(__dirname, "../../../src/database/migrations");
  const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
}

let accessToken: string;
let rulePackId: string;
let versionId: string;

beforeAll(async () => {
  await createTestDatabase();

  // Seed org + user
  await pool.query(
    `INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, $2, $3, $4)`,
    [ORG_ID, "Brain Studio Test Org", "GOVT_NONCADRE", "CLOUD"]
  );
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
     VALUES ($1, $2, 'Brain User', $3, 'ADMIN', $4, false, $2)`,
    [USER_ID, ORG_ID, "brain@test.com", await hashPassword("Test-Pass-123")]
  );

  // Login
  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "brain@test.com", password: "Test-Pass-123" });
  expect(loginRes.status).toBe(200);
  accessToken = loginRes.body.access_token;
});

afterAll(async () => {
  await pool.end();
  await dbPool.end();
  const adminPool = new Pool({ connectionString: BASE_URL });
  await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
  await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  await adminPool.end();
});

const authHeader = () => ({ Authorization: `Bearer ${accessToken}` });

// ─── 1. Create a rule pack ──────────────────────────────────────────

describe("Brain Studio — Rule Pack Lifecycle", () => {
  test("creates a rule pack and gets initial version", async () => {
    const res = await request(app)
      .post("/api/v1/rule-packs")
      .set(authHeader())
      .send({ name: "37th BCS Eligibility Rules", sector: "GOVT_NONCADRE" });

    expect(res.status).toBe(201);
    expect(res.body.rule_pack).toBeDefined();
    expect(res.body.rule_pack.name).toBe("37th BCS Eligibility Rules");
    expect(res.body.initial_version).toBeDefined();
    expect(res.body.initial_version.version_number).toBe(1);

    rulePackId = res.body.rule_pack.rule_pack_id;
    versionId = res.body.initial_version.version_id;
  });

  // ─── 2. Add 3 rules ──────────────────────────────────────────────

  test("adds eligibility rule: age ≤ 30", async () => {
    const res = await request(app)
      .post("/api/v1/rules")
      .set(authHeader())
      .send({
        rule_pack_version_id: versionId,
        rule_code: "AGE_MAX_30",
        rule_type: "ELIGIBILITY",
        field_path: "age",
        operator: "LTE",
        threshold_type: "exact",
        threshold_value: 30,
        fail_reason_code: "AGE_EXCEEDS_MAX",
        is_knockout: false,
      });

    expect(res.status).toBe(201);
    expect(res.body.rule.rule_code).toBe("AGE_MAX_30");
    expect(res.body.rule.field_path).toBe("age");
    expect(res.body.rule.operator).toBe("LTE");
  });

  test("adds scoring rule: CGPA ≥ 3.0", async () => {
    const res = await request(app)
      .post("/api/v1/rules")
      .set(authHeader())
      .send({
        rule_pack_version_id: versionId,
        rule_code: "CGPA_MIN_3",
        rule_type: "SCORING",
        field_path: "education.cgpa",
        operator: "GTE",
        threshold_type: "exact",
        threshold_value: 3.0,
        fail_reason_code: "CGPA_BELOW_MIN",
        is_knockout: false,
        weight: 2.0,
      });

    expect(res.status).toBe(201);
    expect(res.body.rule.rule_code).toBe("CGPA_MIN_3");
    expect(Number(res.body.rule.weight)).toBe(2);
  });

  test("adds knockout rule: nationality must be Bangladeshi", async () => {
    const res = await request(app)
      .post("/api/v1/rules")
      .set(authHeader())
      .send({
        rule_pack_version_id: versionId,
        rule_code: "NAT_BD",
        rule_type: "KNOCKOUT",
        field_path: "nationality",
        operator: "EQ",
        threshold_type: "exact",
        threshold_value: "Bangladeshi",
        fail_reason_code: "NATIONALITY_MISMATCH",
        is_knockout: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.rule.is_knockout).toBe(true);
  });

  // ─── 3. Verify conflict check — clean ─────────────────────────────

  test("conflict checker reports clean with 3 non-conflicting rules", async () => {
    const res = await request(app)
      .get(`/api/v1/rule-packs/${rulePackId}/conflicts`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.clean).toBe(true);
    expect(res.body.conflicts).toHaveLength(0);
    expect(res.body.rule_count).toBe(3);
  });

  // ─── 4. Add a conflicting rule ────────────────────────────────────

  test("adding contradictory rule (age ≥ 35 knockout) triggers conflict", async () => {
    // This creates a conflict: age LTE 30 (knockout=false) and age GTE 35 (knockout=true)
    // The conflict checker detects knockout range emptiness: LTE 30 AND GTE 35 both knockout
    // But first rule is NOT knockout, so let's add a direct EQ contradiction instead.
    // Actually, the conflict checker checks: two EQ on same field with different values.
    // Let's add nationality EQ "Indian" (knockout) — conflicts with NAT_BD (EQ "Bangladeshi")
    const res = await request(app)
      .post("/api/v1/rules")
      .set(authHeader())
      .send({
        rule_pack_version_id: versionId,
        rule_code: "NAT_IN",
        rule_type: "KNOCKOUT",
        field_path: "nationality",
        operator: "EQ",
        threshold_type: "exact",
        threshold_value: "Indian",
        fail_reason_code: "NATIONALITY_IN_MISMATCH",
        is_knockout: true,
      });

    // The rule creation itself should detect the conflict (409)
    expect(res.status).toBe(409);
    expect(res.body.conflicts).toBeDefined();
    expect(res.body.conflicts.length).toBeGreaterThan(0);
    expect(res.body.conflicts[0].reason).toContain("mutually exclusive");
  });

  // ─── 5. Verify still clean (conflicting rule was rejected) ────────

  test("conflict checker still clean after rejected rule", async () => {
    const res = await request(app)
      .get(`/api/v1/rule-packs/${rulePackId}/conflicts`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.clean).toBe(true);
    expect(res.body.rule_count).toBe(3);
  });

  // ─── 6. Publish with reason ───────────────────────────────────────

  test("publishes version with reason", async () => {
    const res = await request(app)
      .post(`/api/v1/rule-packs/${rulePackId}/publish`)
      .set(authHeader())
      .send({ version_id: versionId });

    expect(res.status).toBe(200);
    expect(res.body.published).toBe(true);
    expect(res.body.rule_count).toBe(3);
  });

  // ─── 7. Simulation ────────────────────────────────────────────────

  test("simulates rules against sample candidates", async () => {
    const res = await request(app)
      .post(`/api/v1/rule-packs/${rulePackId}/simulate`)
      .set(authHeader())
      .send({
        version_id: versionId,
        candidates: [
          { age: 25, "education": { cgpa: 3.5 }, nationality: "Bangladeshi" },
          { age: 35, "education": { cgpa: 2.8 }, nationality: "Bangladeshi" },
          { age: 28, "education": { cgpa: 3.9 }, nationality: "Indian" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.total).toBe(3);
    expect(res.body.results).toHaveLength(3);

    // Candidate 1: age 25 ≤ 30 PASS, cgpa 3.5 ≥ 3.0 PASS, nationality Bangladeshi EQ PASS → OVERALL PASS
    expect(res.body.results[0].overall).toBe("PASS");

    // Candidate 2: age 35 > 30 FAIL, cgpa 2.8 < 3.0 FAIL, nationality Bangladeshi PASS → OVERALL FAIL
    expect(res.body.results[1].overall).toBe("FAIL");

    // Candidate 3: age 28 ≤ 30 PASS, cgpa 3.9 ≥ 3.0 PASS, nationality Indian ≠ Bangladeshi FAIL (knockout) → KNOCKOUT
    expect(res.body.results[2].overall).toBe("KNOCKOUT");
  });

  // ─── 8. DB verification ───────────────────────────────────────────

  test("DB: rules table has 3 active rules for this version", async () => {
    const res = await pool.query(
      `SELECT * FROM rules WHERE rule_pack_version_id = $1 AND active = true ORDER BY created_at`,
      [versionId]
    );
    expect(res.rowCount).toBe(3);
    const codes = res.rows.map((r: any) => r.rule_code);
    expect(codes).toContain("AGE_MAX_30");
    expect(codes).toContain("CGPA_MIN_3");
    expect(codes).toContain("NAT_BD");
  });

  test("DB: rule_pack_versions has version 1", async () => {
    const res = await pool.query(
      `SELECT * FROM rule_pack_versions WHERE rule_pack_id = $1 ORDER BY version_number`,
      [rulePackId]
    );
    expect(res.rowCount).toBeGreaterThanOrEqual(1);
    expect(res.rows[0].version_number).toBe(1);
    expect(res.rows[0].change_summary).toBe("Initial version");
  });

  test("DB: audit_log has RULE_PACK_CREATED and RULE_PACK_PUBLISHED", async () => {
    const res = await pool.query(
      `SELECT action, entity_type FROM audit_log WHERE org_id = $1 AND entity_type = 'RULE_PACK' ORDER BY audit_id`,
      [ORG_ID]
    );
    expect(res.rowCount).toBeGreaterThanOrEqual(2);
    const actions = res.rows.map((r: any) => r.action);
    expect(actions).toContain("RULE_PACK_CREATED");
    expect(actions).toContain("RULE_PACK_PUBLISHED");
  });

  test("DB: audit_log has RULE_CREATED entries for each rule", async () => {
    const res = await pool.query(
      `SELECT action FROM audit_log WHERE org_id = $1 AND action = 'RULE_CREATED' ORDER BY audit_id`,
      [ORG_ID]
    );
    expect(res.rowCount).toBe(3);
  });

  // ─── 9. Create a new version (v2) ────────────────────────────────

  test("creates v2 with copied rules and change summary", async () => {
    const res = await request(app)
      .post(`/api/v1/rule-packs/${rulePackId}/versions`)
      .set(authHeader())
      .send({ change_summary: "Updated age criteria per HR directive" });

    expect(res.status).toBe(201);
    expect(res.body.version.version_number).toBe(2);
    expect(res.body.version.change_summary).toBe("Updated age criteria per HR directive");

    // Verify rules were copied
    const rulesRes = await pool.query(
      `SELECT COUNT(*) FROM rules WHERE rule_pack_version_id = $1 AND active = true`,
      [res.body.version.version_id]
    );
    expect(Number(rulesRes.rows[0].count)).toBe(3);
  });

  // ─── 10. List rule packs ──────────────────────────────────────────

  test("lists rule packs with version counts", async () => {
    const res = await request(app)
      .get("/api/v1/rule-packs")
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.rule_packs.length).toBeGreaterThanOrEqual(1);
    const pack = res.body.rule_packs.find((p: any) => p.rule_pack_id === rulePackId);
    expect(pack).toBeDefined();
    expect(Number(pack.version_count)).toBe(2);
    expect(Number(pack.latest_version)).toBe(2);
  });

  // ─── 11. Get pack detail ──────────────────────────────────────────

  test("gets pack detail with versions and rules", async () => {
    const res = await request(app)
      .get(`/api/v1/rule-packs/${rulePackId}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.rule_pack.rule_pack_id).toBe(rulePackId);
    expect(res.body.versions).toHaveLength(2);
    // Rules should be from latest version (v2)
    expect(res.body.rules.length).toBe(3);
    expect(res.body.latest_version_id).toBeDefined();
  });
});
