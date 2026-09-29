/**
 * Quest 05 Part 1 — Real-database authentication & session test.
 *
 * Verifies the full auth lifecycle against a real Postgres:
 *   1. Login (bad password, unknown email, password_reset_required, success).
 *   2. Session-bound access tokens (revoked session → 401 SESSION_ENDED).
 *   3. Refresh rotation (old token replay revokes the whole session).
 *   4. Logout / logout-all.
 *   5. Password change (wrong current, policy, other-session revocation).
 *   6. Reset link lifecycle: issue → verify (clicked) → confirm (consumed).
 *   7. Invite + in-person admin handoff link.
 *   8. Session list + self revoke + admin revoke.
 *
 * Requires: a running Postgres accessible at DATABASE_URL_TEST (falls
 * back to postgres://uros:uros@localhost:5443/uros).
 */
import { Pool } from "pg";
import request from "supertest";
import path from "path";
import { readdirSync, readFileSync } from "fs";

// ─── Environment override — MUST happen before any src/ import ───────
const REAL_DB = "uros_auth_test";
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
import { hashPassword } from "../../../src/services/auth/password";

// Every login/change/reset path pays the full bcrypt (rounds 12) cost —
// under parallel jest workers that CPU contention pushes individual tests
// past the default 5s, so this suite owns a generous per-test budget.
jest.setTimeout(20_000);

// ─── Constants ───────────────────────────────────────────────────────
const ORG = "bbbbbbbb-2222-2222-2222-222222222222";
const ADMIN = "cccccccc-aaaa-1111-1111-111111111111";
const RECRUITER = "cccccccc-bbbb-2222-2222-222222222222";
const FRESH_ADMIN = "cccccccc-cccc-3333-3333-333333333333";
const PASSWORD = "Correct-Horse-9";
const NEW_PASSWORD = "Staple-Tonic-42";

function extractTokenFromLink(link: string): string {
  const q = link.split("?")[1] ?? "";
  const params = new URLSearchParams(q);
  const token = params.get("token");
  if (!token) throw new Error(`No token in link: ${link}`);
  return token;
}

function refreshCookieOf(res: request.Response): string {
  const jar = res.headers["set-cookie"];
  const cookie = (Array.isArray(jar) ? jar : [jar]).find((c: string) => c.startsWith("uros_refresh="));
  if (!cookie) throw new Error("No uros_refresh cookie set");
  return cookie.split(";")[0];
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
    `INSERT INTO organizations(org_id, name, sector, deployment_mode) VALUES ($1, 'Auth Test Org', 'CORPORATE', 'CLOUD')`,
    [ORG]
  );
  // Admin with a working password.
  await pool.query(
    `INSERT INTO users(user_id, org_id, full_name, email, phone, role, active, password_hash, password_reset_required)
     VALUES ($1, $2, 'Auth Admin', 'admin@auth-test.local', '+8801700000001', 'ADMIN', true, $3, false)`,
    [ADMIN, ORG, await hashPassword(PASSWORD)]
  );
  // Recruiter with a working password.
  await pool.query(
    `INSERT INTO users(user_id, org_id, full_name, email, phone, role, active, password_hash, password_reset_required)
     VALUES ($1, $2, 'Auth Recruiter', 'recruiter@auth-test.local', '+8801700000002', 'RECRUITER', true, $3, false)`,
    [RECRUITER, ORG, await hashPassword(PASSWORD)]
  );
  // Fresh admin: created by seed/invite semantics — no password yet, must
  // complete the set-password flow before sign-in (Decision Lock 1).
  await pool.query(
    `INSERT INTO users(user_id, org_id, full_name, email, phone, role, active, password_reset_required)
     VALUES ($1, $2, 'Fresh Admin', 'fresh@auth-test.local', '+8801700000003', 'ADMIN', true, true)`,
    [FRESH_ADMIN, ORG]
  );
}

// ─── Test suite ──────────────────────────────────────────────────────
describe("Quest 05 — Authentication & sessions (real DB)", () => {
  const app = createApp();

  beforeAll(async () => {
    await createTestDatabase();
    await runAllMigrations();
    await seedData();
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    const adminPool = new Pool({ connectionString: BASE_URL });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${REAL_DB}`);
    } finally {
      await adminPool.end();
    }
  });

  // Test isolation: several assertions count absolute rows (session-list
  // length, logout-all counts, the 6th-login eviction). Session and
  // reset-token state must therefore never leak between tests. Refresh
  // tokens cascade away with their session; users and their passwords are
  // kept so the suite's deliberate password-mutation chain stays intact.
  beforeEach(async () => {
    await pool.query(`DELETE FROM user_sessions WHERE user_id = ANY($1::uuid[])`, [
      [ADMIN, RECRUITER, FRESH_ADMIN],
    ]);
    await pool.query(`DELETE FROM password_reset_tokens WHERE user_id = ANY($1::uuid[])`, [
      [ADMIN, RECRUITER, FRESH_ADMIN],
    ]);
  });

  // ─── Login ─────────────────────────────────────────────────────────
  it("rejects a wrong password and an unknown email with the same shape (anti-enumeration)", async () => {
    const wrongPw = await request(app).post("/api/v1/auth/login").send({ email: "admin@auth-test.local", password: "nope-not-it" });
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.body.error_code).toBe("INVALID_CREDENTIALS");

    const unknown = await request(app).post("/api/v1/auth/login").send({ email: "nobody@auth-test.local", password: "nope-not-it" });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error_code).toBe("INVALID_CREDENTIALS");
  });

  it("blocks sign-in while password_reset_required is set (no temp passwords, no bypass)", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email: "fresh@auth-test.local", password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error_code).toBe("PASSWORD_RESET_REQUIRED");
  });

  it("logs in with correct credentials: access token, user, httpOnly refresh cookie", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email: "admin@auth-test.local", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.expires_in).toBe(3600);
    expect(res.body.user).toMatchObject({ role: "ADMIN", password_reset_required: false, email: "admin@auth-test.local" });

    const cookie = refreshCookieOf(res);
    expect(cookie).toMatch(/^uros_refresh=/);
    const setCookie = (Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : [res.headers["set-cookie"]]).join(" ");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/api\/v1\/auth/);

    // Session-bound token works on an authenticated endpoint.
    const me = await request(app)
      .get("/api/v1/users/me/sessions")
      .set("Authorization", `Bearer ${res.body.access_token}`);
    expect(me.status).toBe(200);
    expect(me.body.sessions).toHaveLength(1);
    expect(me.body.sessions[0].current).toBe(true);
    expect(me.body.sessions[0].ip).not.toBeNull();
  });

  it("refresh rotates the token; replaying the old token revokes the whole session", async () => {
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: PASSWORD });
    const firstCookie = refreshCookieOf(loginRes);
    const firstAccess = loginRes.body.access_token;

    // Rotation succeeds and sets a NEW cookie.
    const refreshRes = await request(app).post("/api/v1/auth/refresh").set("Cookie", firstCookie);
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.access_token).toBeTruthy();
    const secondCookie = refreshCookieOf(refreshRes);
    expect(secondCookie).not.toBe(firstCookie);

    // Session-bound token still valid after rotation.
    const me = await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${refreshRes.body.access_token}`);
    expect(me.status).toBe(200);

    // Replaying the OLD (rotated-away) token is a theft response: 401 and
    // the whole session is revoked — even the fresh token stops working.
    const replay = await request(app).post("/api/v1/auth/refresh").set("Cookie", firstCookie);
    expect(replay.status).toBe(401);

    const afterReplay = await request(app)
      .get("/api/v1/users/me/sessions")
      .set("Authorization", `Bearer ${refreshRes.body.access_token}`);
    expect(afterReplay.status).toBe(401);
    expect(afterReplay.body.error_code).toBe("SESSION_ENDED");

    // And the first access token is equally dead.
    const firstAccessDead = await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${firstAccess}`);
    expect(firstAccessDead.status).toBe(401);
  });

  it("logout revokes only the current session; other devices survive", async () => {
    const a = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: PASSWORD });
    const b = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: PASSWORD });

    const out = await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${a.body.access_token}`);
    expect(out.status).toBe(200);
    expect(out.headers["set-cookie"]).toBeDefined(); // cookie cleared

    const aDead = await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${a.body.access_token}`);
    expect(aDead.status).toBe(401);
    const bAlive = await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${b.body.access_token}`);
    expect(bAlive.status).toBe(200);
  });

  it("logout-all revokes every session for the user", async () => {
    const a = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: PASSWORD });
    const b = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: PASSWORD });

    const out = await request(app).post("/api/v1/auth/logout-all").set("Authorization", `Bearer ${b.body.access_token}`);
    expect(out.status).toBe(200);
    expect(out.body.revoked_sessions).toBe(2);

    expect((await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${a.body.access_token}`)).status).toBe(401);
    expect((await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${b.body.access_token}`)).status).toBe(401);
  });

  // ─── Password change ───────────────────────────────────────────────
  it("password change: rejects wrong current password and weak new password", async () => {
    const loginRes = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: PASSWORD });

    const wrongCurrent = await request(app)
      .post("/api/v1/auth/password/change")
      .set("Authorization", `Bearer ${loginRes.body.access_token}`)
      .send({ current_password: "not-the-password", new_password: NEW_PASSWORD });
    expect(wrongCurrent.status).toBe(401);
    expect(wrongCurrent.body.error_code).toBe("INVALID_CURRENT_PASSWORD");

    const weak = await request(app)
      .post("/api/v1/auth/password/change")
      .set("Authorization", `Bearer ${loginRes.body.access_token}`)
      .send({ current_password: PASSWORD, new_password: "short" });
    expect(weak.status).toBe(422);
    expect(weak.body.error_code).toBe("PASSWORD_POLICY");
  });

  it("password change: succeeds, logs with ip/agent, and signs out other devices but not this one", async () => {
    const main = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: PASSWORD });
    const other = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: PASSWORD });

    const change = await request(app)
      .post("/api/v1/auth/password/change")
      .set("Authorization", `Bearer ${main.body.access_token}`)
      .set("User-Agent", "jest-auth-test-agent")
      .send({ current_password: PASSWORD, new_password: NEW_PASSWORD });
    expect(change.status).toBe(200);

    // This device survives; the other one is dead.
    expect((await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${main.body.access_token}`)).status).toBe(200);
    expect((await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${other.body.access_token}`)).status).toBe(401);

    // Decision Lock 1: every password change is logged with timestamp, IP, user agent.
    // IP/UA live inside the audit's input_value JSONB.
    const audit = await pool.query(
      `SELECT input_value->>'ip' AS ip, input_value->>'user_agent' AS user_agent
       FROM audit_log WHERE action='PASSWORD_CHANGED' AND entity_id=$1 ORDER BY timestamp DESC LIMIT 1`,
      [RECRUITER]
    );
    expect(audit.rows[0].user_agent).toBe("jest-auth-test-agent");
    expect(audit.rows[0].ip).toBeTruthy();

    // Old password no longer works; new one does (then restore for later tests).
    expect(
      (await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: PASSWORD })).status
    ).toBe(401);
    const backIn = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: NEW_PASSWORD });
    expect(backIn.status).toBe(200);
  });

  // ─── Reset link lifecycle ──────────────────────────────────────────
  it("reset request answers generically whether or not the email exists", async () => {
    const existing = await request(app).post("/api/v1/auth/password/reset/request").send({ email: "recruiter@auth-test.local" });
    expect(existing.status).toBe(200);
    expect(existing.body.message).toMatch(/If an account exists/);

    const unknown = await request(app).post("/api/v1/auth/password/reset/request").send({ email: "ghost@auth-test.local" });
    expect(unknown.status).toBe(200);
    expect(unknown.body.message).toMatch(/If an account exists/);

    // A token row was issued for the real account (delivery itself will
    // fail in this environment — no BYOK credentials — which is audited,
    // and the in-person handoff below is the working alternative).
    const issued = await pool.query(
      `SELECT COUNT(*)::int AS n FROM password_reset_tokens prt
       JOIN users u ON u.user_id = prt.user_id
       WHERE u.email = 'recruiter@auth-test.local'`
    );
    expect(issued.rows[0].n).toBeGreaterThan(0);
  });

  it("in-person handoff: admin gets a raw link, verify marks clicked, confirm consumes and sets the password", async () => {
    // Fresh admin cannot sign in yet.
    expect(
      (await request(app).post("/api/v1/auth/login").send({ email: "fresh@auth-test.local", password: NEW_PASSWORD })).status
    ).toBe(403);

    const adminLogin = await request(app).post("/api/v1/auth/login").send({ email: "admin@auth-test.local", password: PASSWORD });
    expect(adminLogin.status).toBe(200);

    // RBAC: non-admin cannot issue handoff links.
    const recruiterLogin = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: NEW_PASSWORD });
    expect(
      (await request(app).post(`/api/v1/users/${FRESH_ADMIN}/password-reset-link`).set("Authorization", `Bearer ${recruiterLogin.body.access_token}`)).status
    ).toBe(403);

    const linkRes = await request(app).post(`/api/v1/users/${FRESH_ADMIN}/password-reset-link`).set("Authorization", `Bearer ${adminLogin.body.access_token}`);
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.reset_link).toContain("/reset-password?token=");
    expect(linkRes.body.expires_in_minutes).toBe(30);

    const rawToken = extractTokenFromLink(linkRes.body.reset_link);

    // Verify (the reset screen's first call) marks the link clicked.
    const verify = await request(app).get(`/api/v1/auth/password/reset/verify?token=${rawToken}`);
    expect(verify.status).toBe(200);
    expect(verify.body).toEqual({ valid: true, expired: false });

    // Confirm sets the password and clears the flag.
    const confirm = await request(app)
      .post("/api/v1/auth/password/reset/confirm")
      .send({ token: rawToken, new_password: NEW_PASSWORD });
    expect(confirm.status).toBe(200);

    // Login now works with the new password.
    const freshLogin = await request(app).post("/api/v1/auth/login").send({ email: "fresh@auth-test.local", password: NEW_PASSWORD });
    expect(freshLogin.status).toBe(200);
    expect(freshLogin.body.user.password_reset_required).toBe(false);

    // Lifecycle audit trail: issued → clicked → consumed.
    const trail = await pool.query(
      `SELECT issued_at, clicked_at, consumed_at, issued_via, channel FROM password_reset_tokens prt
       JOIN users u ON u.user_id = prt.user_id
       WHERE u.email = 'fresh@auth-test.local' AND prt.consumed_at IS NOT NULL
       ORDER BY prt.issued_at DESC LIMIT 1`
    );
    expect(trail.rows[0].issued_via).toBe("ADMIN_HANDOFF");
    expect(trail.rows[0].clicked_at).not.toBeNull();
    expect(trail.rows[0].consumed_at).not.toBeNull();
  });

  it("reset confirm rejects a reused (consumed) link", async () => {
    // Request a self-service link for the recruiter (raw token is not
    // returned by design), consume it via the admin handoff path instead:
    // issue → confirm → confirm again with the same token must fail.
    const adminLogin = await request(app).post("/api/v1/auth/login").send({ email: "admin@auth-test.local", password: PASSWORD });
    const linkRes = await request(app).post(`/api/v1/users/${FRESH_ADMIN}/password-reset-link`).set("Authorization", `Bearer ${adminLogin.body.access_token}`);
    const rawToken = extractTokenFromLink(linkRes.body.reset_link);

    // Another admin-handoff link for the same user: the first raw token
    // is still unconsumed — consume it via confirm, then replay.
    const confirm = await request(app).post("/api/v1/auth/password/reset/confirm").send({ token: rawToken, new_password: "Different-Key-77" });
    expect(confirm.status).toBe(200);

    const replay = await request(app).post("/api/v1/auth/password/reset/confirm").send({ token: rawToken, new_password: "Third-Try-99" });
    expect(replay.status).toBe(400);
    expect(replay.body.error_code).toBe("RESET_TOKEN_INVALID");
  });

  // ─── Invite ────────────────────────────────────────────────────────
  it("invite creates a password_reset_required user and returns a one-time link", async () => {
    const adminLogin = await request(app).post("/api/v1/auth/login").send({ email: "admin@auth-test.local", password: PASSWORD });

    const invite = await request(app)
      .post("/api/v1/users/invite")
      .set("Authorization", `Bearer ${adminLogin.body.access_token}`)
      .send({ email: "invited@auth-test.local", full_name: "Invited One", role: "RECRUITER", phone: "+8801700000004" });
    expect(invite.status).toBe(201);
    expect(invite.body.user.password_reset_required).toBe(true);
    expect(invite.body.reset_link).toContain("/reset-password?token=");

    // Duplicate email rejected.
    const duplicate = await request(app)
      .post("/api/v1/users/invite")
      .set("Authorization", `Bearer ${adminLogin.body.access_token}`)
      .send({ email: "invited@auth-test.local", full_name: "Dup", role: "RECRUITER" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error_code).toBe("EMAIL_IN_USE");

    // The invited person sets their own password through the link.
    const rawToken = extractTokenFromLink(invite.body.reset_link);
    expect(
      (await request(app).post("/api/v1/auth/password/reset/confirm").send({ token: rawToken, new_password: "Welcome-Key-77" })).status
    ).toBe(200);
    expect(
      (await request(app).post("/api/v1/auth/login").send({ email: "invited@auth-test.local", password: "Welcome-Key-77" })).status
    ).toBe(200);
  });

  // ─── Session management ────────────────────────────────────────────
  it("session manager: revoke one own session; admin revokes all sessions of a user", async () => {
    const recruiterLogin = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: NEW_PASSWORD });
    const adminLogin = await request(app).post("/api/v1/auth/login").send({ email: "admin@auth-test.local", password: PASSWORD });
    const recruiterAuth = `Bearer ${recruiterLogin.body.access_token}`;

    const second = await request(app).post("/api/v1/auth/login").send({ email: "recruiter@auth-test.local", password: NEW_PASSWORD });

    const list = await request(app).get("/api/v1/users/me/sessions").set("Authorization", recruiterAuth);
    expect(list.status).toBe(200);
    expect(list.body.sessions.length).toBe(2);
    const otherSession = list.body.sessions.find((s: { current: boolean }) => !s.current);
    expect(otherSession).toBeTruthy();

    // Self-revoke the other session.
    const revoke = await request(app).delete(`/api/v1/users/me/sessions/${otherSession.session_id}`).set("Authorization", recruiterAuth);
    expect(revoke.status).toBe(200);
    expect(
      (await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${second.body.access_token}`)).status
    ).toBe(401);

    // Cannot revoke someone else's session.
    const adminSessions = await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${adminLogin.body.access_token}`);
    const adminSessionId = adminSessions.body.sessions[0].session_id;
    expect(
      (await request(app).delete(`/api/v1/users/me/sessions/${adminSessionId}`).set("Authorization", recruiterAuth)).status
    ).toBe(404);

    // Admin revokes ALL recruiter sessions.
    const adminRevoke = await request(app).delete(`/api/v1/users/${RECRUITER}/sessions`).set("Authorization", `Bearer ${adminLogin.body.access_token}`);
    expect(adminRevoke.status).toBe(200);
    expect(adminRevoke.body.revoked_sessions).toBe(1);
    expect(
      (await request(app).get("/api/v1/users/me/sessions").set("Authorization", recruiterAuth)).status
    ).toBe(401);
  });

  it("session cap: creating a 6th session evicts the oldest (audited)", async () => {
    const logins: string[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post("/api/v1/auth/login").send({ email: "admin@auth-test.local", password: PASSWORD });
      expect(res.status).toBe(200);
      logins.push(res.body.access_token);
    }

    // The oldest of the 6 is dead; the newest 5 are alive.
    const alive = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL`,
      [ADMIN]
    );
    expect(alive.rows[0].n).toBe(5);

    const evicted = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_log WHERE action='SESSION_EVICTED' AND entity_id=$1`,
      [ADMIN]
    );
    expect(evicted.rows[0].n).toBeGreaterThan(0);

    // The very first token (evicted session) is dead; the last is alive.
    expect((await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${logins[0]}`)).status).toBe(401);
    expect((await request(app).get("/api/v1/users/me/sessions").set("Authorization", `Bearer ${logins[5]}`)).status).toBe(200);
  });
});
