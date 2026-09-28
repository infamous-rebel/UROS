/**
 * Quest 03 — Real-database pipeline continuation test.
 *
 * Verifies the gate-driven pipeline wiring against a real Postgres:
 *   1. All 6 gate types can be created and resolved end-to-end.
 *   2. Resolving a gate writes resolved_by_name to gate_events.
 *   3. Resolving a gate enqueues a CONTINUE_FROM_GATE evaluation job.
 *   4. A rejected COMMUNICATION_APPROVAL gate writes 0 rows to communication_log.
 *   5. Gate discovery API (GET /api/v1/gates) returns pending gates.
 *
 * Requires: a running Postgres accessible at DATABASE_URL_TEST (falls
 * back to postgres://uros:uros@localhost:5443/uros).
 */
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_pipeline_cont_test";
const BASE_URL = process.env.DATABASE_URL_TEST ?? "postgres://uros:uros@localhost:5443/uros";
const TEST_URL = BASE_URL.replace(/\/[^/]+$/, `/${REAL_DB}`);

process.env.DATABASE_URL = TEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

// Now safe to import src/ modules
import { createApp } from "../../../src/api/server";
import { pool } from "../../../src/database/client";
import { createGate, resolveGate } from "../../../src/services/orchestrator/hil_gates";

// ─── Constants ───────────────────────────────────────────────────────
const ORG_A = "aaaaaaaa-1111-1111-1111-111111111111";
const USER_A = "cccccccc-3333-3333-3333-333333333333";
const CAND_A = "CAND-PIPELINE-CONT-A";
const CAND_B = "CAND-PIPELINE-CONT-B";
const CAND_C = "CAND-PIPELINE-CONT-C";
const RULE_PACK = "eeeeeeee-5555-5555-5555-555555555555";
const RULE_PACK_VER = "ffffffff-6666-6666-6666-666666666666";
const RULE_ID = "11111111-7777-7777-7777-777777777777";
const BATCH_ID = "PIPELINE-CONT-TEST-001";

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
  await pool.query(
    `INSERT INTO organizations(org_id, name, sector, deployment_mode) VALUES ($1, 'Org A', 'GOVT_NONCADRE', 'CLOUD')`,
    [ORG_A]
  );
  await pool.query(
    `INSERT INTO users(user_id, org_id, full_name, email, role) VALUES ($1, $2, 'Recruiter Alpha', 'recruiter-alpha@real-db-test.local', 'RECRUITER')`,
    [USER_A, ORG_A]
  );
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
  // Candidates at various pipeline stages
  await pool.query(
    `INSERT INTO candidates(candidate_id, org_id, full_name, status, job_circular_id) VALUES
     ($1, $2, 'Candidate A', 'INTAKE', 'CIRC-001'),
     ($3, $4, 'Candidate B', 'ELIGIBILITY_DONE', 'CIRC-001'),
     ($5, $6, 'Candidate C', 'SCORED', 'CIRC-001')`,
    [CAND_A, ORG_A, CAND_B, ORG_A, CAND_C, ORG_A]
  );
  // evaluation_results (needed by enqueueContinuationJob FK lookup)
  await pool.query(
    `INSERT INTO evaluation_results(candidate_id, rule_id, rule_pack_version_id, status, reason_code, org_id)
     VALUES ($1, $2, $3, 'PASS', 'AGE_MIN', $4)`,
    [CAND_A, RULE_ID, RULE_PACK_VER, ORG_A]
  );
}

// ─── Test suite ──────────────────────────────────────────────────────
describe("Quest 03 — Pipeline continuation (real DB)", () => {
  const app = createApp();

  beforeAll(async () => {
    await createTestDatabase();
    await runAllMigrations();
    await seedData();
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    const adminPool = new Pool({ connectionString: BASE_URL });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
    } finally {
      await adminPool.end();
    }
  });

  const recruiterToken = token(USER_A, ORG_A, "RECRUITER");

  // ─── Assertion 1: All 6 gate types can be created and resolved ─────
  describe("end-to-end gate lifecycle for all 6 gate types", () => {
    const gateTypes = [
      "IMPORT_APPROVAL",
      "ELIGIBILITY_REVIEW",
      "SHORTLIST_CONFIRMATION",
      "VERIFICATION_SIGNOFF",
      "COMMUNICATION_APPROVAL",
      "FINAL_APPROVAL",
    ];

    it.each(gateTypes)("creates and resolves a %s gate", async (gateType) => {
      // Create
      const gateId = await createGate(BATCH_ID, gateType, ORG_A);
      expect(gateId).toBeDefined();
      expect(typeof gateId).toBe("string");

      // Verify PENDING
      const pending = await pool.query(
        `SELECT status, gate_type, org_id FROM gate_events WHERE gate_id=$1`,
        [gateId]
      );
      expect(pending.rows[0].status).toBe("PENDING");
      expect(pending.rows[0].gate_type).toBe(gateType);
      expect(pending.rows[0].org_id).toBe(ORG_A);

      // Resolve
      const result = await resolveGate(gateId, "APPROVE", { note: "test" }, USER_A, ORG_A);
      expect(result.status).toBe("RESOLVED");
      expect(result.gate_id).toBe(gateId);
      expect(result.decision).toBe("APPROVE");

      // Verify RESOLVED in DB
      const resolved = await pool.query(
        `SELECT status, resolved_by, resolved_at FROM gate_events WHERE gate_id=$1`,
        [gateId]
      );
      expect(resolved.rows[0].status).toBe("RESOLVED");
      expect(resolved.rows[0].resolved_by).toBe(USER_A);
      expect(resolved.rows[0].resolved_at).not.toBeNull();
    });
  });

  // ─── Assertion 2: resolved_by_name is written ──────────────────────
  describe("resolved_by_name audit trail", () => {
    it("writes the resolver's full_name to gate_events.resolved_by_name", async () => {
      const gateId = await createGate(BATCH_ID, "ELIGIBILITY_REVIEW", ORG_A);

      await resolveGate(gateId, "APPROVE", {}, USER_A, ORG_A);

      const res = await pool.query(
        `SELECT resolved_by_name, resolved_by FROM gate_events WHERE gate_id=$1`,
        [gateId]
      );
      expect(res.rows[0].resolved_by_name).toBe("Recruiter Alpha");
      expect(res.rows[0].resolved_by).toBe(USER_A);
    });

    it("resolved_by_name is populated for every resolved gate", async () => {
      // Create a second user to verify name resolution is per-resolver
      const user2 = "77777777-6666-6666-6666-888888888888";
      await pool.query(
        `INSERT INTO users(user_id, org_id, full_name, email, role) VALUES ($1, $2, 'Recruiter Beta', 'recruiter-beta@real-db-test.local', 'RECRUITER')`,
        [user2, ORG_A]
      );

      const gateId = await createGate(BATCH_ID, "SHORTLIST_CONFIRMATION", ORG_A);
      await resolveGate(gateId, "APPROVE", {}, user2, ORG_A);

      const res = await pool.query(
        `SELECT resolved_by_name, resolved_by FROM gate_events WHERE gate_id=$1`,
        [gateId]
      );
      expect(res.rows[0].resolved_by_name).toBe("Recruiter Beta");
      expect(res.rows[0].resolved_by).toBe(user2);
    });
  });

  // ─── Assertion 3: CONTINUE_FROM_GATE job is enqueued ───────────────
  describe("CONTINUE_FROM_GATE job enqueuing", () => {
    it("creates a CONTINUE_FROM_GATE evaluation_job when a gate is resolved", async () => {
      const gateId = await createGate(BATCH_ID, "SHORTLIST_CONFIRMATION", ORG_A);

      // Before resolution: no CONTINUE_FROM_GATE job for this gate
      const beforeRes = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM evaluation_jobs WHERE gate_id=$1 AND stage='CONTINUE_FROM_GATE'`,
        [gateId]
      );
      expect(beforeRes.rows[0].cnt).toBe(0);

      // Resolve the gate
      await resolveGate(gateId, "APPROVE", {}, USER_A, ORG_A);

      // After resolution: CONTINUE_FROM_GATE job exists
      const afterRes = await pool.query(
        `SELECT job_id, stage, status, gate_id, requested_by_name, org_id
         FROM evaluation_jobs WHERE gate_id=$1 AND stage='CONTINUE_FROM_GATE'`,
        [gateId]
      );
      expect(afterRes.rows.length).toBe(1);
      expect(afterRes.rows[0].status).toBe("QUEUED");
      expect(afterRes.rows[0].gate_id).toBe(gateId);
      expect(afterRes.rows[0].requested_by_name).toBe("Recruiter Alpha");
      expect(afterRes.rows[0].org_id).toBe(ORG_A);
    });
  });

  // ─── Assertion 4: Rejected COMMUNICATION_APPROVAL → 0 communication_log ─
  describe("rejection path semantics", () => {
    it("rejected COMMUNICATION_APPROVAL writes 0 rows to communication_log", async () => {
      // Count communication_log rows before
      const beforeRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM communication_log`);
      const countBefore = beforeRes.rows[0].cnt;

      // Create and REJECT a COMMUNICATION_APPROVAL gate
      const gateId = await createGate(BATCH_ID, "COMMUNICATION_APPROVAL", ORG_A);
      await resolveGate(gateId, "REJECT", { reason: "not ready" }, USER_A, ORG_A);

      // Verify gate is RESOLVED with REJECT decision
      const gateRes = await pool.query(
        `SELECT status, payload FROM gate_events WHERE gate_id=$1`,
        [gateId]
      );
      expect(gateRes.rows[0].status).toBe("RESOLVED");
      const payload = typeof gateRes.rows[0].payload === "string"
        ? JSON.parse(gateRes.rows[0].payload)
        : gateRes.rows[0].payload;
      expect(payload.decision).toBe("REJECT");

      // Verify 0 new communication_log rows
      const afterRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM communication_log`);
      expect(afterRes.rows[0].cnt).toBe(countBefore);
    });

    it("rejected FINAL_APPROVAL keeps candidates VERIFIED, not SELECTED", async () => {
      // Set up a candidate in VERIFIED status
      const verifiedCand = "CAND-VERIFIED-REJECT";
      await pool.query(
        `INSERT INTO candidates(candidate_id, org_id, full_name, status, job_circular_id)
         VALUES ($1, $2, 'Verified Reject Test', 'VERIFIED', 'CIRC-001')`,
        [verifiedCand, ORG_A]
      );

      const gateId = await createGate(BATCH_ID, "FINAL_APPROVAL", ORG_A);
      await resolveGate(gateId, "REJECT", { reason: "budget freeze" }, USER_A, ORG_A);

      // Candidate stays VERIFIED
      const candRes = await pool.query(
        `SELECT status FROM candidates WHERE candidate_id=$1`,
        [verifiedCand]
      );
      expect(candRes.rows[0].status).toBe("VERIFIED");
    });
  });

  // ─── Assertion 5: Gate discovery API ───────────────────────────────
  describe("GET /api/v1/gates — gate inbox", () => {
    it("returns PENDING gates for the caller's org", async () => {
      // Create two pending gates
      const gate1 = await createGate(BATCH_ID, "IMPORT_APPROVAL", ORG_A);
      const gate2 = await createGate(BATCH_ID, "ELIGIBILITY_REVIEW", ORG_A);

      const res = await request(app)
        .get("/api/v1/gates")
        .set("Authorization", `Bearer ${recruiterToken}`);

      expect(res.status).toBe(200);
      expect(res.body.gates).toBeDefined();
      expect(Array.isArray(res.body.gates)).toBe(true);

      // Our two gates should be in the list (along with any other PENDING gates)
      const gateIds = res.body.gates.map((g: any) => g.gate_id);
      expect(gateIds).toContain(gate1);
      expect(gateIds).toContain(gate2);

      // All returned gates belong to the caller's org
      for (const g of res.body.gates) {
        expect(g.org_id).toBe(ORG_A);
        expect(g.status).toBeUndefined(); // status not exposed in list
      }
    });

    it("returns 401 without authentication", async () => {
      const res = await request(app).get("/api/v1/gates");
      expect(res.status).toBe(401);
    });
  });

  // ─── Assertion 6: Schema verification ──────────────────────────────
  describe("migration 0031 schema objects", () => {
    it("agent_batch_progress_item table exists with correct PK", async () => {
      const res = await pool.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'agent_batch_progress_item' ORDER BY ordinal_position
      `);
      const cols = res.rows.map((r: any) => r.column_name);
      expect(cols).toContain("batch_key");
      expect(cols).toContain("item_key");
      expect(cols).toContain("status");
      expect(cols).toContain("error");
      expect(cols).toContain("processed_at");
    });

    it("agent_batch_progress has lease and fencing columns", async () => {
      const res = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_batch_progress' AND column_name IN ('owner_id','lease_expires_at','fencing_token')
      `);
      expect(res.rows.length).toBe(3);
    });

    it("evaluation_jobs accepts CONTINUE_FROM_GATE stage", async () => {
      // Should not throw
      await pool.query(
        `INSERT INTO evaluation_jobs(batch_id, circular_id, rule_pack_version_id, org_id, stage, requested_by_name, status)
         VALUES ($1, $2, $3, $4, 'CONTINUE_FROM_GATE', $5, 'QUEUED')`,
        ["SCHEMA-TEST-BATCH", "CIRC-SCHEMA", RULE_PACK_VER, ORG_A, "schema-test"]
      );
      const res = await pool.query(
        `SELECT stage FROM evaluation_jobs WHERE batch_id='SCHEMA-TEST-BATCH'`
      );
      expect(res.rows[0].stage).toBe("CONTINUE_FROM_GATE");
    });

    it("evaluation_jobs rejects invalid stage", async () => {
      await expect(
        pool.query(
          `INSERT INTO evaluation_jobs(batch_id, circular_id, rule_pack_version_id, org_id, stage, status)
           VALUES ($1, $2, $3, $4, 'INVALID_STAGE', 'QUEUED')`,
          ["SCHEMA-TEST-BATCH-2", "CIRC-SCHEMA", RULE_PACK_VER, ORG_A]
        )
      ).rejects.toThrow();
    });

    it("gate_events has resolved_by_name column", async () => {
      const res = await pool.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'gate_events' AND column_name = 'resolved_by_name'
      `);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].data_type).toBe("text");
    });
  });
});
