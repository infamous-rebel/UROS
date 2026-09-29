/**
 * Quest 05 Part 2 — Real-database CommandBar test.
 *
 * Verifies the org switcher, dashboard summary, notifications, and global
 * search endpoints against a real Postgres:
 *   1. Org switcher: seed 2 orgs, 1 user with 2 memberships, login, switch,
 *      verify JWT org changes and session rotation.
 *   2. Dashboard summary: seed candidates in various statuses, verify counts.
 *   3. Notifications: seed gates/tasks/deliveries, verify grouped response.
 *   4. Global search: seed candidates/rules, verify search results.
 *
 * Requires: a running Postgres accessible at DATABASE_URL_TEST.
 */
import { Pool } from "pg";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_commandbar_test";
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

jest.setTimeout(20_000);

// ─── Constants ───────────────────────────────────────────────────────
const ORG_A = "aaaaaaaa-1111-1111-1111-111111111111";
const ORG_B = "bbbbbbbb-2222-2222-2222-222222222222";
const USER = "cccccccc-1111-1111-1111-111111111111";
const PASSWORD = "Correct-Horse-9";

const pool = new Pool({ connectionString: TEST_URL });
const app = createApp();

async function createTestDatabase(): Promise<void> {
  const adminPool = new Pool({ connectionString: BASE_URL });
  try {
    // Terminate all existing connections before dropping.
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
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

beforeAll(async () => {
  await createTestDatabase();
  await runAllMigrations();

  // Seed: 2 orgs, 1 user with memberships in both, password set.
  await pool.query(`INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, 'Org A', 'GOVT_NONCADRE', 'CLOUD'), ($2, 'Org B', 'PRIVATE_BANK', 'CLOUD') ON CONFLICT DO NOTHING`, [ORG_A, ORG_B]);
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
     VALUES ($1, $2, 'Test User', 'test@example.com', 'ADMIN', $3, false, $2)
     ON CONFLICT (user_id) DO UPDATE SET org_id=EXCLUDED.org_id, password_hash=EXCLUDED.password_hash`,
    [USER, ORG_A, await hashPassword(PASSWORD)]
  );
  await pool.query(`INSERT INTO user_org_memberships (user_id, org_id, role) VALUES ($1, $2, 'ADMIN'), ($1, $3, 'RECRUITER') ON CONFLICT DO NOTHING`, [USER, ORG_A, ORG_B]);
});

afterAll(async () => {
  // End both the local test pool and the db singleton pool cleanly first.
  await pool.end();
  await dbPool.end();
  const adminPool = new Pool({ connectionString: BASE_URL });
  try {
    // Terminate any straggling connections, then drop.
    await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
    await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  } finally {
    await adminPool.end();
  }
});

beforeEach(async () => {
  // Clean slate for each test.
  await pool.query(`DELETE FROM user_sessions WHERE user_id=$1`, [USER]);
  await pool.query(`DELETE FROM candidates WHERE org_id IN ($1, $2)`, [ORG_A, ORG_B]);
  await pool.query(`DELETE FROM gate_events WHERE org_id IN ($1, $2)`, [ORG_A, ORG_B]);
  await pool.query(`DELETE FROM task_logs WHERE org_id IN ($1, $2)`, [ORG_A, ORG_B]);
  await pool.query(`DELETE FROM rule_packs WHERE org_id IN ($1, $2)`, [ORG_A, ORG_B]);
  await pool.query(`DELETE FROM communication_log WHERE candidate_id IN (SELECT candidate_id FROM candidates WHERE org_id IN ($1, $2))`, [ORG_A, ORG_B]);
  // Reset preferred org to ORG_A so tests start from a known state.
  await pool.query(`UPDATE users SET preferred_org_id=$2 WHERE user_id=$1`, [USER, ORG_A]);
});

describe("Org switcher", () => {
  it("lists memberships with active flag", async () => {
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "test@example.com", password: PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.access_token;

    const orgsRes = await request(app).get("/api/v1/auth/orgs").set("Authorization", `Bearer ${token}`);
    expect(orgsRes.status).toBe(200);
    expect(orgsRes.body.orgs).toHaveLength(2);
    const active = orgsRes.body.orgs.find((o: any) => o.active);
    expect(active.org_id).toBe(ORG_A);
  });

  it("switches org and rotates session", async () => {
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "test@example.com", password: PASSWORD });
    const token1 = loginRes.body.access_token;

    // Switch to ORG_B.
    const switchRes = await request(app).post(`/api/v1/auth/orgs/${ORG_B}/switch`).set("Authorization", `Bearer ${token1}`);
    expect(switchRes.status).toBe(200);
    expect(switchRes.body.user.org_id).toBe(ORG_B);
    const token2 = switchRes.body.access_token;

    // Old token should be dead (session revoked).
    const oldRes = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token1}`);
    expect(oldRes.status).toBe(401);

    // New token should work and show ORG_B.
    const meRes = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token2}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.org_id).toBe(ORG_B);
  });

  it("rejects switch to non-member org", async () => {
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "test@example.com", password: PASSWORD });
    const token = loginRes.body.access_token;

    const fakeOrg = "ffffffff-9999-9999-9999-999999999999";
    const switchRes = await request(app).post(`/api/v1/auth/orgs/${fakeOrg}/switch`).set("Authorization", `Bearer ${token}`);
    expect(switchRes.status).toBe(403);
  });
});

describe("Dashboard summary", () => {
  it("returns correct counts", async () => {
    // Seed candidates in various statuses.
    await pool.query(
      `INSERT INTO candidates (candidate_id, org_id, full_name, status) VALUES
       ('cand-1', $1, 'Alice', 'ELIGIBLE_APPROVED'),
       ('cand-2', $1, 'Bob', 'SHORTLISTED'),
       ('cand-3', $1, 'Charlie', 'REJECTED'),
       ('cand-4', $1, 'Dave', 'NEEDS_REVIEW'),
       ('cand-5', $1, 'Eve', 'INTAKE')`,
      [ORG_A]
    );

    const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "test@example.com", password: PASSWORD });
    const token = loginRes.body.access_token;

    const summaryRes = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${token}`);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.auto_pass).toBe(2); // ELIGIBLE_APPROVED + SHORTLISTED
    expect(summaryRes.body.auto_fail).toBe(1); // REJECTED
    expect(summaryRes.body.needs_review).toBe(1); // NEEDS_REVIEW
    expect(summaryRes.body.overdue_gates).toBe(0);
  });
});

describe("Notifications", () => {
  it("returns grouped previews", async () => {
    // Seed a pending gate.
    await pool.query(
      `INSERT INTO gate_events (gate_id, batch_id, gate_type, org_id, status) VALUES ('11111111-1111-1111-1111-111111111111', 'batch-1', 'IMPORT_APPROVAL', $1, 'PENDING')`,
      [ORG_A]
    );

    // Seed an overdue task.
    await pool.query(
      `INSERT INTO task_logs (task_id, org_id, assignee_id, created_by, title, status, due_date) VALUES ('22222222-2222-2222-2222-222222222222', $1, $2, $2, 'Overdue task', 'TODO', now() - interval '1 day')`,
      [ORG_A, USER]
    );

    const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "test@example.com", password: PASSWORD });
    const token = loginRes.body.access_token;

    const notifRes = await request(app).get("/api/v1/notifications").set("Authorization", `Bearer ${token}`);
    expect(notifRes.status).toBe(200);
    expect(notifRes.body.total).toBe(2);
    expect(notifRes.body.groups.gates.count).toBe(1);
    expect(notifRes.body.groups.tasks.count).toBe(1);
    expect(notifRes.body.groups.deliveries.count).toBe(0);
  });
});

describe("Global search", () => {
  it("searches candidates and rules", async () => {
    await pool.query(
      `INSERT INTO candidates (candidate_id, org_id, full_name, email, status) VALUES ('cand-search-1', $1, 'Alice Smith', 'alice@example.com', 'INTAKE')`,
      [ORG_A]
    );
    await pool.query(
      `INSERT INTO rule_packs (rule_pack_id, org_id, name, sector) VALUES ('33333333-3333-3333-3333-333333333333', $1, 'Engineering Rules', 'Engineering')`,
      [ORG_A]
    );

    const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "test@example.com", password: PASSWORD });
    const token = loginRes.body.access_token;

    const searchRes = await request(app).get("/api/v1/search?q=alice").set("Authorization", `Bearer ${token}`);
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.results.length).toBeGreaterThan(0);
    const candidateResult = searchRes.body.results.find((r: any) => r.category === "candidate");
    expect(candidateResult).toBeDefined();
    expect(candidateResult.title).toBe("Alice Smith");
  });
});
