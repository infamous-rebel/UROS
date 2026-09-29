/**
 * Checkpoint A E2E — Database setup.
 * Creates a fresh DB, runs migrations, seeds test users for curl E2E.
 */
import { Pool } from "pg";
import path from "path";
import { readdirSync, readFileSync } from "fs";

const BASE_URL = "postgres://uros:uros@localhost:5443/uros";
const E2E_DB = "uros_e2e_test";
const E2E_URL = BASE_URL.replace(/\/[^/]+$/, `/${E2E_DB}`);

async function main() {
  const adminPool = new Pool({ connectionString: BASE_URL });

  // Terminate existing connections and recreate DB
  await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${E2E_DB}' AND pid <> pg_backend_pid()`);
  await adminPool.query(`DROP DATABASE IF EXISTS ${E2E_DB}`);
  await adminPool.query(`CREATE DATABASE ${E2E_DB}`);
  await adminPool.end();

  const pool = new Pool({ connectionString: E2E_URL });

  // Run all migrations
  const migrationsDir = path.resolve(__dirname, "../../src/database/migrations");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
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
  console.log(`Applied ${files.length} migrations.`);

  // Seed test data
  const ORG_ID = "dddddddd-1111-1111-1111-111111111111";
  const USER_NORMAL = "eeeeeeee-1111-1111-1111-111111111111";
  const USER_RESET_REQ = "eeeeeeee-2222-2222-2222-222222222222";
  const USER_INACTIVE = "eeeeeeee-3333-3333-3333-333333333333";

  // Org
  await pool.query(
    `INSERT INTO organizations (org_id, name, sector, deployment_mode) VALUES ($1, 'E2E Test Org', 'STATE_BANK', 'CLOUD') ON CONFLICT DO NOTHING`,
    [ORG_ID]
  );

  // Normal user (password: "Secure-Pass-99")
  const { hashPassword } = await import("../../src/services/auth/password");
  const normalHash = await hashPassword("Secure-Pass-99");
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, phone, role, password_hash, password_reset_required, active, preferred_org_id)
     VALUES ($1, $2, 'E2E Normal User', 'normal@e2e.test', '+8801700000001', 'ADMIN', $3, false, true, $2)
     ON CONFLICT (user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_reset_required=false, active=true`,
    [USER_NORMAL, ORG_ID, normalHash]
  );

  // User with password_reset_required = true
  const resetHash = await hashPassword("Old-Pass-123");
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, phone, role, password_hash, password_reset_required, active, preferred_org_id)
     VALUES ($1, $2, 'E2E Reset User', 'reset@e2e.test', '+8801700000002', 'RECRUITER', $3, true, true, $2)
     ON CONFLICT (user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, password_reset_required=true, active=true`,
    [USER_RESET_REQ, ORG_ID, resetHash]
  );

  // Inactive user
  const inactiveHash = await hashPassword("Inactive-Pass-1");
  await pool.query(
    `INSERT INTO users (user_id, org_id, full_name, email, phone, role, password_hash, password_reset_required, active, preferred_org_id)
     VALUES ($1, $2, 'E2E Inactive', 'inactive@e2e.test', '+8801700000003', 'RECRUITER', $3, false, false, $2)
     ON CONFLICT (user_id) DO UPDATE SET active=false`,
    [USER_INACTIVE, ORG_ID, inactiveHash]
  );

  // Memberships
  await pool.query(
    `INSERT INTO user_org_memberships (user_id, org_id, role) VALUES ($1, $2, 'ADMIN') ON CONFLICT DO NOTHING`,
    [USER_NORMAL, ORG_ID]
  );
  await pool.query(
    `INSERT INTO user_org_memberships (user_id, org_id, role) VALUES ($1, $2, 'RECRUITER') ON CONFLICT DO NOTHING`,
    [USER_RESET_REQ, ORG_ID]
  );

  console.log("Seed complete.");
  console.log(`  ORG_ID:         ${ORG_ID}`);
  console.log(`  USER_NORMAL:    ${USER_NORMAL} (normal@e2e.test / Secure-Pass-99)`);
  console.log(`  USER_RESET_REQ: ${USER_RESET_REQ} (reset@e2e.test / Old-Pass-123, password_reset_required=true)`);
  console.log(`  USER_INACTIVE:  ${USER_INACTIVE} (inactive@e2e.test / Inactive-Pass-1, active=false)`);
  console.log(`\nDATABASE_URL=${E2E_URL}`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
