/**
 * Quest 02 — Real-database tenant isolation test.
 *
 * Unlike the fake-DB integration tests, this file connects to a real
 * Postgres instance, applies all migrations, seeds two orgs with data,
 * mounts the real Express app with real routes and a real pg pool, and
 * verifies tenant isolation end-to-end via supertest HTTP calls.
 *
 * Requires: a running Postgres accessible at DATABASE_URL_TEST (falls
 * back to postgres://uros:uros@localhost:5443/uros). The test creates
 * a disposable database (uros_real_db_test) for each run.
 */
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_real_db_test";
const BASE_URL = process.env.DATABASE_URL_TEST ?? "postgres://uros:uros@localhost:5443/uros";
const TEST_URL = BASE_URL.replace(/\/[^/]+$/, `/${REAL_DB}`);

process.env.DATABASE_URL = TEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

// Now safe to import src/ modules (pool will be created with TEST_URL)
import { createApp } from "../../../src/api/server";
import { pool } from "../../../src/database/client";

// ─── Constants ───────────────────────────────────────────────────────
const ORG_A = "aaaaaaaa-1111-1111-1111-111111111111";
const ORG_B = "bbbbbbbb-2222-2222-2222-222222222222";
const USER_A = "cccccccc-3333-3333-3333-333333333333";
const USER_B = "dddddddd-4444-4444-4444-444444444444";
const CAND_A = "CAND-REAL-A";
const CAND_B = "CAND-REAL-B";
const RULE_PACK = "eeeeeeee-5555-5555-5555-555555555555";
const RULE_PACK_VER = "ffffffff-6666-6666-6666-666666666666";
const RULE_ID = "11111111-7777-7777-7777-777777777777";

function token(userId: string, orgId: string, role: string): string {
  return jwt.sign({ user_id: userId, org_id: orgId, role }, process.env.JWT_SECRET!, { expiresIn: 3600 });
}

// ─── Database bootstrap ──────────────────────────────────────────────
async function createTestDatabase(): Promise<void> {
  const adminPool = new Pool({ connectionString: BASE_URL });
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
    await adminPool.query(`CREATE DATABASE ${REAL_DB}`);
  } finally {
    await adminPool.end();
  }
}

async function runAllMigrations(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, "../../../src/database/migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  // Create schema_migrations table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

async function seedData(): Promise<void> {
  // Orgs
  await pool.query(
    `INSERT INTO organizations(org_id, name, sector, deployment_mode) VALUES
     ($1, 'Org A', 'GOVT_NONCADRE', 'CLOUD'),
     ($2, 'Org B', 'BCS', 'CLOUD')`,
    [ORG_A, ORG_B]
  );

  // Users
  await pool.query(
    `INSERT INTO users(user_id, org_id, full_name, email, role) VALUES
     ($1, $2, 'Admin A', 'admin-a@real-db-test.local', 'ADMIN'),
     ($3, $4, 'Admin B', 'admin-b@real-db-test.local', 'ADMIN')`,
    [USER_A, ORG_A, USER_B, ORG_B]
  );

  // Rule pack chain (for Org A — needed for evaluation_results FK)
  await pool.query(
    `INSERT INTO rule_packs(rule_pack_id, org_id, name, sector) VALUES ($1, $2, 'Real Pack', 'GOVT_NONCADRE')`,
    [RULE_PACK, ORG_A]
  );
  await pool.query(
    `INSERT INTO rule_pack_versions(version_id, rule_pack_id, version_number) VALUES ($1, $2, 1)`,
    [RULE_PACK_VER, RULE_PACK]
  );
  await pool.query(
    `INSERT INTO rules(rule_id, rule_pack_version_id, rule_code, rule_type, field_path, operator, threshold_value, fail_reason_code)
     VALUES ($1, $2, 'AGE_MIN', 'ELIGIBILITY', 'age', 'GTE', '"18"', 'AGE_BELOW_18')`,
    [RULE_ID, RULE_PACK_VER]
  );

  // Candidates
  await pool.query(
    `INSERT INTO candidates(candidate_id, org_id, full_name, status) VALUES
     ($1, $2, 'Candidate A', 'INTAKE'),
     ($3, $4, 'Candidate B', 'INTAKE')`,
    [CAND_A, ORG_A, CAND_B, ORG_B]
  );

  // evaluation_results (one per org)
  await pool.query(
    `INSERT INTO evaluation_results(candidate_id, rule_id, rule_pack_version_id, status, reason_code, org_id) VALUES
     ($1, $2, $3, 'PASS', 'AGE_MIN', $4),
     ($5, $6, $7, 'FAIL', 'AGE_MIN', $8)`,
    // Org B's candidate needs its own rule pack for the FK. Reuse the same rule_pack_version.
    // Actually, both candidates can share the same rule_pack_version since it belongs to ORG_A.
    // For a cleaner test, let's just insert both with the same rule references but different org_id.
    [CAND_A, RULE_ID, RULE_PACK_VER, ORG_A, CAND_B, RULE_ID, RULE_PACK_VER, ORG_B]
  );

  // appeals (one per org)
  const appealResA = await pool.query(
    `INSERT INTO appeals(candidate_id, category, reason_text, status, org_id) VALUES ($1, 'Data Error', 'Wrong data', 'SUBMITTED', $2) RETURNING appeal_id`,
    [CAND_A, ORG_A]
  );
  const appealResB = await pool.query(
    `INSERT INTO appeals(candidate_id, category, reason_text, status, org_id) VALUES ($1, 'Data Error', 'Wrong score', 'SUBMITTED', $2) RETURNING appeal_id`,
    [CAND_B, ORG_B]
  );

  // audit_log entries (one TENANT per org, one SYSTEM)
  await pool.query(
    `INSERT INTO audit_log(org_id, scope, entity_type, entity_id, agent_or_user, action, reason_code) VALUES
     ($1, 'TENANT', 'CANDIDATE', $2, 'SYSTEM', 'CANDIDATE_CREATED', 'INIT'),
     ($3, 'TENANT', 'CANDIDATE', $4, 'SYSTEM', 'CANDIDATE_CREATED', 'INIT'),
     (NULL, 'SYSTEM', 'AGENT_BATCH', 'batch-xyz', 'AgentRunner', 'BATCH_DONE', 'DONE')`,
    [ORG_A, CAND_A, ORG_B, CAND_B]
  );

  // Store appeal IDs for cross-org 404 test
  (globalThis as any).__APPEAL_A_ID__ = appealResA.rows[0].appeal_id;
  (globalThis as any).__APPEAL_B_ID__ = appealResB.rows[0].appeal_id;
}

// ─── Test suite ──────────────────────────────────────────────────────
describe("Quest 02 — Real-database tenant isolation", () => {
  const app = createApp();
  let appealAId: string;
  let appealBId: string;

  beforeAll(async () => {
    await createTestDatabase();
    await runAllMigrations();
    await seedData();
    appealAId = (globalThis as any).__APPEAL_A_ID__;
    appealBId = (globalThis as any).__APPEAL_B_ID__;
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    // Clean up the test database
    const adminPool = new Pool({ connectionString: BASE_URL });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
    } finally {
      await adminPool.end();
    }
  });

  const adminA = token(USER_A, ORG_A, "ADMIN");
  const adminB = token(USER_B, ORG_B, "ADMIN");

  // ─── Audit isolation ─────────────────────────────────────────────
  it("Admin A sees only org A audit entries", async () => {
    const res = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${adminA}`);
    expect(res.status).toBe(200);
    const entries = res.body.entries ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0].org_id).toBe(ORG_A);
    expect(entries[0].entity_id).toBe(CAND_A);
  });

  it("Admin B sees only org B audit entries", async () => {
    const res = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${adminB}`);
    expect(res.status).toBe(200);
    const entries = res.body.entries ?? [];
    expect(entries.length).toBe(1);
    expect(entries[0].org_id).toBe(ORG_B);
    expect(entries[0].entity_id).toBe(CAND_B);
  });

  // ─── Appeals anti-enumeration ────────────────────────────────────
  it("Admin A GET /appeals/:id (org B appeal) returns 404", async () => {
    const res = await request(app)
      .get(`/api/v1/appeals/${appealBId}`)
      .set("Authorization", `Bearer ${adminA}`);
    expect(res.status).toBe(404);
  });

  it("Admin B GET /appeals/:id (org A appeal) returns 404", async () => {
    const res = await request(app)
      .get(`/api/v1/appeals/${appealAId}`)
      .set("Authorization", `Bearer ${adminB}`);
    expect(res.status).toBe(404);
  });

  it("Admin A GET /appeals/:id (own org) returns 200", async () => {
    const res = await request(app)
      .get(`/api/v1/appeals/${appealAId}`)
      .set("Authorization", `Bearer ${adminA}`);
    expect(res.status).toBe(200);
    expect(res.body.appeal).toBeDefined();
    expect(res.body.appeal.candidate_id).toBe(CAND_A);
  });

  // ─── No NULL org_id on TENANT rows ──────────────────────────────
  it("No audit_log rows with scope=TENANT and org_id IS NULL", async () => {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE scope = 'TENANT' AND org_id IS NULL`
    );
    expect(res.rows[0].cnt).toBe(0);
  });

  it("No evaluation_results rows with org_id IS NULL", async () => {
    const res = await pool.query(`SELECT COUNT(*)::int AS cnt FROM evaluation_results WHERE org_id IS NULL`);
    expect(res.rows[0].cnt).toBe(0);
  });

  it("No appeals rows with org_id IS NULL", async () => {
    const res = await pool.query(`SELECT COUNT(*)::int AS cnt FROM appeals WHERE org_id IS NULL`);
    expect(res.rows[0].cnt).toBe(0);
  });

  // ─── SYSTEM scope rows can have NULL org_id ─────────────────────
  it("SYSTEM scope audit_log row exists with NULL org_id", async () => {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE scope = 'SYSTEM' AND org_id IS NULL`
    );
    expect(res.rows[0].cnt).toBe(1);
  });

  // ─── CHECK constraint enforcement ──────────────────────────────
  it("CHECK constraint rejects TENANT scope with NULL org_id", async () => {
    await expect(
      pool.query(
        `INSERT INTO audit_log(entity_type, entity_id, agent_or_user, action, scope)
         VALUES ('TEST', 'test-x', 'tester', 'TEST', 'TENANT')`
      )
    ).rejects.toThrow(/chk_audit_tenant_has_org/);
  });
});
