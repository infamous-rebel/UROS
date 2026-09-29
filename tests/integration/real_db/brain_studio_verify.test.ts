/**
 * Quest 05 Part 6 — Brain Studio E2E verification script.
 *
 * Creates a disposable DB, starts the API, runs the full flow via supertest,
 * prints raw output for every step, then tears down.
 *
 * Usage: npx jest tests/integration/real_db/brain_studio_verify.test.ts --no-coverage --verbose
 */
import { Pool } from "pg";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";

const REAL_DB = "uros_brain_studio_verify";
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

jest.setTimeout(60_000);

const ORG_ID = "ffffffff-8888-8888-8888-888888888888";
const USER_ID = "aaaaaaaa-8888-8888-8888-888888888888";
const pool = new Pool({ connectionString: TEST_URL });
const app = createApp();

beforeAll(async () => {
  const adminPool = new Pool({ connectionString: BASE_URL });
  try {
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } catch { /* */ }
  await adminPool.query(`CREATE DATABASE ${REAL_DB}`);
  await adminPool.end();

  const migrationsDir = path.resolve(__dirname, "../../../src/database/migrations");
  const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await pool.query(sql);
  }

  await pool.query(
    `INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, $2, $3, $4)`,
    [ORG_ID, "Brain Studio Verify Org", "GOVT_NONCADRE", "CLOUD"]
  );
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
     VALUES ($1, $2, 'Verify User', $3, 'ADMIN', $4, false, $2)`,
    [USER_ID, ORG_ID, "verify@test.com", await hashPassword("Test-Pass-123")]
  );
});

afterAll(async () => {
  await pool.end();
  await dbPool.end();
  const adminPool = new Pool({ connectionString: BASE_URL });
  await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
  await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  await adminPool.end();
});

test("FULL BRAIN STUDIO E2E VERIFICATION", async () => {
  const log = (msg: string) => console.log(`\n${"=".repeat(70)}\n${msg}\n${"=".repeat(70)}`);

  // ─── Login ──────────────────────────────────────────────────────
  log("STEP 0: Login");
  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "verify@test.com", password: "Test-Pass-123" });
  console.log("POST /api/v1/auth/login →", loginRes.status);
  expect(loginRes.status).toBe(200);
  const token = loginRes.body.access_token;
  const auth = { Authorization: `Bearer ${token}` };

  // ─── STEP 1: Create a rule pack ─────────────────────────────────
  log("STEP 1: Create Rule Pack");
  const createRes = await request(app)
    .post("/api/v1/rule-packs")
    .set(auth)
    .send({ name: "37th BCS Eligibility Rules", sector: "GOVT_NONCADRE" });
  console.log("POST /api/v1/rule-packs →", createRes.status);
  console.log("Response:", JSON.stringify(createRes.body, null, 2));
  expect(createRes.status).toBe(201);
  const packId = createRes.body.rule_pack.rule_pack_id;
  const versionId = createRes.body.initial_version.version_id;
  console.log("Pack ID:", packId);
  console.log("Version ID:", versionId);

  // ─── STEP 2: Add 3 rules ────────────────────────────────────────
  log("STEP 2a: Add Eligibility Rule (age ≤ 30)");
  const rule1 = await request(app)
    .post("/api/v1/rules")
    .set(auth)
    .send({
      rule_pack_version_id: versionId,
      rule_code: "AGE_MAX_30",
      rule_type: "ELIGIBILITY",
      field_path: "age",
      operator: "LTE",
      threshold_type: "exact",
      threshold_value: 30,
      fail_reason_code: "AGE_EXCEEDS_MAX",
    });
  console.log("POST /api/v1/rules →", rule1.status);
  console.log("Rule:", JSON.stringify(rule1.body.rule, null, 2));
  expect(rule1.status).toBe(201);

  log("STEP 2b: Add Scoring Rule (CGPA ≥ 3.0, weight 2)");
  const rule2 = await request(app)
    .post("/api/v1/rules")
    .set(auth)
    .send({
      rule_pack_version_id: versionId,
      rule_code: "CGPA_MIN_3",
      rule_type: "SCORING",
      field_path: "education.cgpa",
      operator: "GTE",
      threshold_type: "exact",
      threshold_value: 3.0,
      fail_reason_code: "CGPA_BELOW_MIN",
      weight: 2,
    });
  console.log("POST /api/v1/rules →", rule2.status);
  console.log("Rule:", JSON.stringify(rule2.body.rule, null, 2));
  expect(rule2.status).toBe(201);

  log("STEP 2c: Add Knockout Rule (nationality = Bangladeshi)");
  const rule3 = await request(app)
    .post("/api/v1/rules")
    .set(auth)
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
  console.log("POST /api/v1/rules →", rule3.status);
  console.log("Rule:", JSON.stringify(rule3.body.rule, null, 2));
  expect(rule3.status).toBe(201);

  // ─── STEP 3: Conflict check (clean) ─────────────────────────────
  log("STEP 3: Conflict Checker — should be CLEAN");
  const conflicts1 = await request(app)
    .get(`/api/v1/rule-packs/${packId}/conflicts`)
    .set(auth);
  console.log("GET /api/v1/rule-packs/:id/conflicts →", conflicts1.status);
  console.log("Response:", JSON.stringify(conflicts1.body, null, 2));
  expect(conflicts1.body.clean).toBe(true);

  // ─── STEP 4: Deliberate conflict ────────────────────────────────
  log("STEP 4: Add contradictory rule (nationality = Indian, knockout) — should FAIL with 409");
  const conflictRule = await request(app)
    .post("/api/v1/rules")
    .set(auth)
    .send({
      rule_pack_version_id: versionId,
      rule_code: "NAT_IN",
      rule_type: "KNOCKOUT",
      field_path: "nationality",
      operator: "EQ",
      threshold_type: "exact",
      threshold_value: "Indian",
      fail_reason_code: "NATIONALITY_IN",
      is_knockout: true,
    });
  console.log("POST /api/v1/rules →", conflictRule.status);
  console.log("Response:", JSON.stringify(conflictRule.body, null, 2));
  expect(conflictRule.status).toBe(409);
  expect(conflictRule.body.conflicts.length).toBeGreaterThan(0);

  // ─── STEP 5: Publish is blocked ─────────────────────────────────
  log("STEP 5: Publish attempt — should succeed (conflicting rule was rejected, not stored)");
  const publishRes = await request(app)
    .post(`/api/v1/rule-packs/${packId}/publish`)
    .set(auth)
    .send({ version_id: versionId });
  console.log("POST /api/v1/rule-packs/:id/publish →", publishRes.status);
  console.log("Response:", JSON.stringify(publishRes.body, null, 2));
  expect(publishRes.status).toBe(200);
  expect(publishRes.body.published).toBe(true);

  // ─── STEP 6: DB queries ─────────────────────────────────────────
  log("STEP 6a: DB — SELECT * FROM rules WHERE rule_pack_version_id = ...");
  const rulesDb = await pool.query(
    `SELECT rule_id, rule_code, rule_type, field_path, operator, threshold_value, is_knockout, active
     FROM rules WHERE rule_pack_version_id = $1 AND active = true ORDER BY created_at`,
    [versionId]
  );
  console.log(`Row count: ${rulesDb.rowCount}`);
  for (const row of rulesDb.rows) {
    console.log(`  ${row.rule_code.padEnd(15)} ${row.rule_type.padEnd(12)} ${row.field_path.padEnd(20)} ${row.operator.padEnd(5)} ${JSON.stringify(row.threshold_value).padEnd(15)} knockout=${row.is_knockout}`);
  }
  expect(rulesDb.rowCount).toBe(3);

  log("STEP 6b: DB — SELECT * FROM rule_pack_versions");
  const versionsDb = await pool.query(
    `SELECT version_id, version_number, change_summary, created_at FROM rule_pack_versions WHERE rule_pack_id = $1 ORDER BY version_number`,
    [packId]
  );
  console.log(`Row count: ${versionsDb.rowCount}`);
  for (const row of versionsDb.rows) {
    console.log(`  v${row.version_number}: ${row.change_summary} (${row.created_at})`);
  }
  expect(versionsDb.rowCount).toBeGreaterThanOrEqual(1);

  log("STEP 6c: DB — SELECT * FROM audit_log (RULE_PACK actions)");
  const auditDb = await pool.query(
    `SELECT audit_id, action, entity_type, output_value, timestamp FROM audit_log WHERE org_id = $1 AND entity_type = 'RULE_PACK' ORDER BY audit_id`,
    [ORG_ID]
  );
  console.log(`Row count: ${auditDb.rowCount}`);
  for (const row of auditDb.rows) {
    console.log(`  #${row.audit_id} ${row.action.padEnd(25)} ${row.timestamp}`);
    if (row.action === "RULE_PACK_PUBLISHED") {
      console.log(`    output: ${row.output_value}`);
    }
  }
  const actions = auditDb.rows.map((r: any) => r.action);
  expect(actions).toContain("RULE_PACK_CREATED");
  expect(actions).toContain("RULE_PACK_PUBLISHED");

  // ─── STEP 7: Simulation ─────────────────────────────────────────
  log("STEP 7: Simulation — 3 sample candidates");
  const simRes = await request(app)
    .post(`/api/v1/rule-packs/${packId}/simulate`)
    .set(auth)
    .send({
      version_id: versionId,
      candidates: [
        { name: "Candidate A", age: 25, education: { cgpa: 3.5 }, nationality: "Bangladeshi" },
        { name: "Candidate B", age: 35, education: { cgpa: 2.8 }, nationality: "Bangladeshi" },
        { name: "Candidate C", age: 28, education: { cgpa: 3.9 }, nationality: "Indian" },
      ],
    });
  console.log("POST /api/v1/rule-packs/:id/simulate →", simRes.status);
  console.log("Summary:", JSON.stringify(simRes.body.summary, null, 2));
  for (const r of simRes.body.results) {
    console.log(`\n  Candidate #${r.candidate_index + 1}: ${r.overall}`);
    console.log(`    Pass: ${r.pass}, Fail: ${r.fail}, Review: ${r.needs_review}`);
    for (const rr of r.rule_results) {
      console.log(`    ${rr.rule_code.padEnd(15)} ${rr.status.padEnd(15)} input=${JSON.stringify(rr.input_value)} → ${rr.reason_code}`);
    }
  }
  expect(simRes.status).toBe(200);
  expect(simRes.body.summary.total).toBe(3);
  expect(simRes.body.results[0].overall).toBe("PASS");
  expect(simRes.body.results[1].overall).toBe("FAIL");
  expect(simRes.body.results[2].overall).toBe("KNOCKOUT");

  log("✅ BRAIN STUDIO E2E VERIFICATION COMPLETE — ALL STEPS PASSED");
});
