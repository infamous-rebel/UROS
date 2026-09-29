/**
 * Auth endpoints for the staff dashboard — Quest 05 Part 1c.
 *
 * Thin wrappers over authedRequest. The login response's access token is
 * stored in memory only (client.ts, Decision Lock 2); the refresh token
 * rides the httpOnly cookie and is never touched here. All error paths
 * surface ApiError with `.errorCode` so screens can map them to plain
 * language.
 */
import { authedRequest, API_V1, setAccessToken, getAccessToken } from "./client";

export interface AuthUser {
  user_id: string;
  org_id: string;
  role: string;
  full_name: string;
  email: string;
  preferred_language: string | null;
  password_reset_required: boolean;
}

export interface SessionEntry {
  session_id: string;
  created_at: string;
  last_used_at: string;
  absolute_expires_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

/** POST /auth/login — stores the returned access token in memory. */
export async function login(email: string, password: string, remember = true): Promise<AuthUser> {
  const body = await authedRequest<{ access_token: string; user: AuthUser }>(`${API_V1}/auth/login`, {
    method: "POST",
    body: JSON.stringify({ email, password, remember_me: remember }),
  });
  setAccessToken(body.access_token);
  return body.user;
}

/** POST /auth/logout — revokes this session; clears the in-memory token. */
export async function logout(): Promise<void> {
  try {
    if (getAccessToken()) {
      await authedRequest(`${API_V1}/auth/logout`, { method: "POST" });
    }
  } finally {
    // Signing out must always succeed locally, even if the network or the
    // session is already gone — the cookie is cleared server-side on the
    // success path, and the route guard takes over from here.
    setAccessToken(null);
  }
}

/** POST /auth/logout-all — revokes every session for the person. */
export async function logoutAll(): Promise<number> {
  try {
    const body = await authedRequest<{ revoked_sessions: number }>(`${API_V1}/auth/logout-all`, { method: "POST" });
    return body.revoked_sessions;
  } finally {
    setAccessToken(null);
  }
}

/** GET /auth/me — profile for cookie-based boot refresh. */
export async function fetchMe(): Promise<AuthUser> {
  const body = await authedRequest<{ user: AuthUser }>(`${API_V1}/auth/me`);
  return body.user;
}

/** POST /auth/password/change — other devices are signed out server-side. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await authedRequest(`${API_V1}/auth/password/change`, {
    method: "POST",
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}

/** POST /auth/password/reset/request — the answer is generic by design. */
export async function requestPasswordReset(email: string): Promise<string> {
  const body = await authedRequest<{ message: string }>(`${API_V1}/auth/password/reset/request`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  return body.message;
}

/** GET /auth/password/reset/verify?token=… — marks the link clicked. */
export async function verifyResetToken(token: string): Promise<{ valid: boolean; expired: boolean }> {
  return authedRequest(`${API_V1}/auth/password/reset/verify?token=${encodeURIComponent(token)}`);
}

/** POST /auth/password/reset/confirm — consumes the link, sets the password. */
export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  await authedRequest(`${API_V1}/auth/password/reset/confirm`, {
    method: "POST",
    body: JSON.stringify({ token, new_password: newPassword }),
  });
}

/** GET /users/me/sessions — the person's active sessions. */
export async function fetchSessions(): Promise<{ sessions: SessionEntry[] }> {
  return authedRequest(`${API_V1}/users/me/sessions`);
}

/** DELETE /users/me/sessions/:sessionId — revoke one own session. */
export async function revokeSession(sessionId: string): Promise<void> {
  await authedRequest(`${API_V1}/users/me/sessions/${sessionId}`, { method: "DELETE" });
}
