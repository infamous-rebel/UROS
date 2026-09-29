/**
 * Quest 05 Part 7 — Settings functional test (real Postgres).
 *
 * Verifies all 12 Settings endpoints:
 *   1. Org profile GET/PATCH
 *   2. User profile GET/PATCH
 *   3. User list GET
 *   4. User edit PATCH
 *   5. User deactivate DELETE
 *   6. Backup trigger POST
 *   7. Backup list GET
 *   8. Audit retention GET/PATCH
 *   9. Data export request POST
 *  10. Data export status GET
 *  11. Credentials list (reuses /credentials)
 *  12. Fallback chains (reuses /integrations/fallback)
 *
 * Uses real Postgres (uros_settings_test).
 */
import { Pool } from "pg";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_settings_test";
const BASE_URL = process.env.DATABASE_URL_TEST ?? "postgres://uros:uros@localhost:5443/uros";
const TEST_URL = BASE_URL.replace(/\/[^/]+$/, `/${REAL_DB}`);

process.env.DATABASE_URL = TEST_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "0".repeat(64);
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.BACKUP_OUTPUT_DIR = "/tmp/uros-settings-test-backups";

import { createApp } from "../../../src/api/server";
import { hashPassword } from "../../../src/services/auth/password";
import { pool as dbPool } from "../../../src/database/client";

jest.setTimeout(30_000);

// ─── Constants ───────────────────────────────────────────────────────
const ORG_ID = "ffffffff-8888-8888-8888-888888888888";
const ADMIN_ID = "aaaaaaaa-8888-8888-8888-888888888888";
const RECRUITER_ID = "aaaaaaaa-8888-8888-8888-999999999999";

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

let adminToken: string;

beforeAll(async () => {
  await createTestDatabase();

  // Seed org + admin user + recruiter user
  await pool.query(
    `INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, $2, $3, $4)`,
    [ORG_ID, "Settings Test Org", "CORPORATE", "CLOUD"]
  );
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
     VALUES ($1, $2, 'Admin User', $3, 'ADMIN', $4, false, $2)`,
    [ADMIN_ID, ORG_ID, "admin@settings.test", await hashPassword("Test-Pass-123")]
  );
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, role, password_hash, password_reset_required, preferred_org_id)
     VALUES ($1, $2, 'Recruiter User', $3, 'RECRUITER', $4, false, $2)`,
    [RECRUITER_ID, ORG_ID, "recruiter@settings.test", await hashPassword("Test-Pass-123")]
  );

  // Login as admin
  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: "admin@settings.test", password: "Test-Pass-123" });
  expect(loginRes.status).toBe(200);
  adminToken = loginRes.body.access_token;
});

afterAll(async () => {
  await pool.end();
  await dbPool.end();
  const adminPool = new Pool({ connectionString: BASE_URL });
  await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${REAL_DB}' AND pid <> pg_backend_pid()`);
  await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
  await adminPool.end();
});

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

// ─── Tests ───────────────────────────────────────────────────────────

describe("Settings — Organization Profile", () => {
  test("GET /settings/me returns org profile", async () => {
    const res = await request(app).get("/api/v1/settings/me").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.organization).toBeDefined();
    expect(res.body.organization.name).toBe("Settings Test Org");
    expect(res.body.organization.sector).toBe("CORPORATE");
  });

  test("PATCH /settings/me updates org name and sector", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/me")
      .set(auth())
      .send({ name: "Updated Org Name", sector: "NGO" });
    expect(res.status).toBe(200);
    expect(res.body.organization.name).toBe("Updated Org Name");
    expect(res.body.organization.sector).toBe("NGO");
  });

  test("audit_log has ORG_PROFILE_UPDATED entry", async () => {
    const audit = await pool.query(
      `SELECT action, entity_type FROM audit_log WHERE action = 'ORG_PROFILE_UPDATED' AND org_id = $1`,
      [ORG_ID]
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Settings — User Profile", () => {
  test("GET /settings/me/profile returns current user", async () => {
    const res = await request(app).get("/api/v1/settings/me/profile").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe("admin@settings.test");
    expect(res.body.user.role).toBe("ADMIN");
  });

  test("PATCH /settings/me/profile updates name and phone", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/me/profile")
      .set(auth())
      .send({ full_name: "Updated Admin", phone: "+8801700000000" });
    expect(res.status).toBe(200);
    expect(res.body.user.full_name).toBe("Updated Admin");
    expect(res.body.user.phone).toBe("+8801700000000");
  });
});

describe("Settings — User Management", () => {
  test("GET /settings/ lists users in org", async () => {
    const res = await request(app).get("/api/v1/settings/").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThanOrEqual(2);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
  });

  test("PATCH /settings/:id edits user role", async () => {
    const res = await request(app)
      .patch(`/api/v1/settings/${RECRUITER_ID}`)
      .set(auth())
      .send({ role: "SENIOR_RECRUITER" });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("SENIOR_RECRUITER");
  });

  test("DELETE /settings/:id deactivates user", async () => {
    const res = await request(app)
      .delete(`/api/v1/settings/${RECRUITER_ID}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify in DB
    const dbCheck = await pool.query(`SELECT active FROM users WHERE user_id = $1`, [RECRUITER_ID]);
    expect(dbCheck.rows[0].active).toBe(false);
  });
});

describe("Settings — Backup", () => {
  test("POST /settings/backup/trigger creates backup file", async () => {
    const res = await request(app)
      .post("/api/v1/settings/backup/trigger")
      .set(auth());
    expect(res.status).toBe(201);
    expect(res.body.filename).toMatch(/^uros-backup-/);
    expect(res.body.size).toBeGreaterThan(0);
  });

  test("GET /settings/backup/list returns backups", async () => {
    const res = await request(app).get("/api/v1/settings/backup/list").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.backups.length).toBeGreaterThanOrEqual(1);
    expect(res.body.backups[0].filename).toMatch(/\.sql\.gz$/);
  });
});

describe("Settings — Audit Retention", () => {
  test("GET /settings/audit/retention returns defaults", async () => {
    const res = await request(app).get("/api/v1/settings/audit/retention").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.retention_days).toBe(90);
  });

  test("PATCH /settings/audit/retention updates retention", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/audit/retention")
      .set(auth())
      .send({ retention_days: 180, archive_after_days: 60 });
    expect(res.status).toBe(200);
    expect(res.body.retention_days).toBe(180);
    expect(res.body.archive_after_days).toBe(60);
  });

  test("audit_log has AUDIT_RETENTION_UPDATED entry", async () => {
    const audit = await pool.query(
      `SELECT action FROM audit_log WHERE action = 'AUDIT_RETENTION_UPDATED' AND org_id = $1`,
      [ORG_ID]
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Settings — Data Export", () => {
  let exportId: string;

  test("POST /settings/data-export/request creates export job", async () => {
    const res = await request(app)
      .post("/api/v1/settings/data-export/request")
      .set(auth());
    expect(res.status).toBe(201);
    expect(res.body.export).toBeDefined();
    expect(res.body.export.status).toBe("PENDING");
    exportId = res.body.export.id;
  });

  test("GET /settings/data-export/status/:id returns job status", async () => {
    const res = await request(app)
      .get(`/api/v1/settings/data-export/status/${exportId}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.export).toBeDefined();
    expect(["PENDING", "READY"]).toContain(res.body.export.status);
  });
});

describe("Settings — Credentials & Fallback (integration)", () => {
  test("GET /settings/credentials endpoint not available (uses /credentials)", async () => {
    // Credentials tab uses /api/v1/credentials directly
    const res = await request(app).get("/api/v1/credentials").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.credentials).toBeDefined();
  });

  test("GET fallback SMS chain uses /integrations/fallback/SMS", async () => {
    const res = await request(app).get("/api/v1/integrations/fallback/SMS").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.provider_order).toBeDefined();
  });
});
