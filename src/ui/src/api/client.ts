/**
 * Minimal API client for the UROS dashboard shell.
 *
 * Quest 05 auth model (Decision Lock 2): the refresh token lives in an
 * httpOnly cookie scoped to /api/v1/auth; the access token is held in
 * memory only — never persisted. Every request includes credentials so
 * the cookie rides along; a 401 from any authed endpoint triggers one
 * silent cookie refresh and a single retry. If that refresh fails,
 * session listeners are notified and the route guard returns the person
 * to sign-in.
 *
 * A dev/service token may still be pasted in development (flag-gated in
 * the CommandBar). It lives in localStorage, never represents a
 * person's session, and is only accepted by the backend's stateless-
 * token path (service tokens, OTP portals).
 */

const API_ORIGIN = (import.meta as any).env?.VITE_API_ORIGIN ?? "http://localhost:3000";
const API_V1 = `${API_ORIGIN}/api/v1`;
export { API_V1 };
const DEV_TOKEN_STORAGE_KEY = "uros_dev_token";

// Access token — memory only (Decision Lock 2).
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Dev/service token (localStorage) — never a person's session. */
export function getToken(): string | null {
  return accessToken ?? localStorage.getItem(DEV_TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(DEV_TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(DEV_TOKEN_STORAGE_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public errorCode?: string) {
    super(message);
    this.name = "ApiError";
  }
}

// ─── Session-ended listeners ─────────────────────────────────────────

type SessionEndedListener = () => void;
const sessionEndedListeners = new Set<SessionEndedListener>();

export function onSessionEnded(listener: SessionEndedListener): () => void {
  sessionEndedListeners.add(listener);
  return () => {
    sessionEndedListeners.delete(listener);
  };
}

function notifySessionEnded(): void {
  accessToken = null;
  for (const listener of sessionEndedListeners) listener();
}

// ─── Cookie refresh ─────────────────────────────────────────────────

const AUTH_PATHS = [
  "/auth/login",
  "/auth/refresh",
  "/auth/password/reset/request",
  "/auth/password/reset/verify",
  "/auth/password/reset/confirm",
];

let refreshInFlight: Promise<boolean> | null = null;

/** One silent cookie refresh. Concurrent callers share the same attempt. */
export function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_V1}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return false;
      const body = await res.json();
      accessToken = body.access_token ?? null;
      return !!accessToken;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request<T>(path: string, init?: RequestInit, allowRefresh = true): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  // Auto-refresh: exactly one silent retry with a cookie-issued token.
  // Never attempt it for the auth endpoints themselves.
  if (res.status === 401 && allowRefresh && !AUTH_PATHS.some((p) => path.includes(p))) {
    if (await refreshAccessToken()) {
      return request<T>(path, init, false);
    }
    notifySessionEnded();
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request failed with status ${res.status}`, body.error_code);
  }
  return res.json() as Promise<T>;
}

export async function authedRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init);
}

/**
 * Per-agent resilience state as reported by the hardening layer
 * (`src/services/agent_runner/agent_health.ts`). Read-only here: the UI
 * renders it, it never influences it.
 */
export interface AgentHealthEntry {
  agent_name: string;
  agent_class: string;
  circuit_state: "CLOSED" | "HALF_OPEN" | "OPEN";
  consecutive_failures: number;
  circuit_retry_after_ms: number;
  invocations: number;
  successes: number;
  failures: number;
  retries: number;
  timeouts: number;
  in_flight: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  status: "healthy" | "degraded" | "unavailable" | "idle";
  /** Tasks waiting for a worker in this agent's class pool. */
  queue_depth: number;
  /** Tasks currently executing in this agent's class pool. */
  queue_active: number;
  pool_size: number;
}

export interface AgentHealthTotals {
  agents: number;
  invocations: number;
  successes: number;
  failures: number;
  retries: number;
  timeouts: number;
  circuits_open: number;
  queued: number;
}

export interface AgentPoolSnapshot {
  name: string;
  size: number;
  active: number;
  queued: number;
  completed: number;
  failed: number;
  rejected: number;
  stopped: boolean;
}

export interface AgentHealthReport {
  agents: AgentHealthEntry[];
  pools: AgentPoolSnapshot[];
  totals: AgentHealthTotals;
}

export interface HealthResponse {
  status: string;
  deployment_mode: string;
  /**
   * Added by Agent-Level Hardening. Optional on purpose: an API build from
   * before that round still answers `/health` correctly, and the dashboard
   * must say so rather than render an empty grid.
   */
  agent_health?: AgentHealthReport;
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>(`${API_ORIGIN}/health`);
}

export interface CandidateSummary {
  candidate_id: string;
  full_name: string;
  status: string;
  source_platform: string | null;
  job_circular_id: string | null;
  position_applied: string | null;
  data_confidence: string | null;
  created_at: string;
  updated_at: string;
  /** Quest 05 Part 3 — populated only when status=NEEDS_REVIEW. */
  reason_code?: string | null;
  eval_confidence?: number | null;
  distance_to_threshold?: number | null;
  input_value?: unknown;
}

export interface CandidateListResponse {
  candidates: CandidateSummary[];
  limit: number;
  offset: number;
  count: number;
}

export function fetchCandidatesByStatus(status: string, limit = 200): Promise<CandidateListResponse> {
  return request<CandidateListResponse>(`${API_V1}/candidates?status=${encodeURIComponent(status)}&limit=${limit}`);
}

/** Quest 05 Part 4 — flexible candidate list with filters, pagination, sort. */
export interface CandidateListParams {
  status?: string;
  circular_id?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function fetchCandidateList(params: CandidateListParams = {}): Promise<CandidateListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.circular_id) qs.set("circular_id", params.circular_id);
  if (params.search) qs.set("search", params.search);
  qs.set("limit", String(params.limit ?? 50));
  qs.set("offset", String(params.offset ?? 0));
  return request<CandidateListResponse>(`${API_V1}/candidates?${qs}`);
}

/** Quest 05 Part 4 — full candidate profile with evaluations, documents, scoring. */
export interface CandidateDetail {
  candidate: CandidateSummary & Record<string, unknown>;
  academic_records: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  evaluation_summary: Array<{
    rule_id: string;
    status: string;
    reason_code: string;
    confidence: number | null;
    distance_to_threshold: number | null;
    human_decision: string | null;
    evaluated_at: string;
    input_value?: unknown;
  }>;
  scoring: {
    total_score: number;
    breakdown: unknown;
    rank: number;
    computed_at: string;
  } | null;
  verification_results: Array<{
    verification_id: string;
    source: string;
    status: string;
    details: unknown;
    checked_at: string;
    signed_off_by: string | null;
    signed_off_at: string | null;
  }>;
}

export function fetchCandidateDetail(id: string): Promise<CandidateDetail> {
  return request<CandidateDetail>(`${API_V1}/candidates/${encodeURIComponent(id)}`);
}

/** Quest 05 Part 4 — audit logs scoped to a specific entity. */
export function fetchEntityAuditLogs(entityType: string, entityId: string, limit = 50): Promise<AuditLogResponse> {
  return request<AuditLogResponse>(
    `${API_V1}/audit-logs?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}&limit=${limit}`
  );
}

/** Quest 05 Part 4 — PATCH candidate status (HIL action). */
export function patchCandidateStatus(id: string, status: string, reason: string): Promise<{ candidate: CandidateSummary }> {
  return request<{ candidate: CandidateSummary }>(`${API_V1}/candidates/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, correction_reason: reason }),
  });
}

/** Quest 05 Part 4 — add a human note to a candidate. */
export function addCandidateNote(id: string, note: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`${API_V1}/candidates/${encodeURIComponent(id)}/notes`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export interface AuditLogEntry {
  audit_id: number;
  entity_type: string;
  entity_id: string;
  agent_or_user: string;
  action: string;
  reason_code: string | null;
  reason_comment: string | null;
  timestamp: string;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  limit: number;
  offset: number;
  count: number;
}

export function fetchAuditLogs(limit = 15): Promise<AuditLogResponse> {
  return request<AuditLogResponse>(`${API_V1}/audit-logs?limit=${limit}`);
}

/** Every pipeline stage status the dashboard tracks in the live strip. */
export const PIPELINE_STAGE_STATUSES = [
  "INTAKE",
  "PARSED",
  "ELIGIBILITY_DONE",
  "NEEDS_REVIEW",
  "SCORED",
  "SHORTLISTED",
  "VERIFIED",
  "SELECTED",
] as const;

export type PipelineStageStatus = (typeof PIPELINE_STAGE_STATUSES)[number];

// ─── Quest 03 — HIL Gate Inbox ───────────────────────────────────────

export interface GateSummary {
  gate_id: string;
  batch_id: string;
  gate_type: string;
  org_id: string;
  payload: unknown;
  created_at: string;
}

export interface GateListResponse {
  gates: GateSummary[];
}

export interface GateDetailResponse {
  gate_id: string;
  batch_id: string;
  gate_type: string;
  org_id: string;
  status: string;
  payload: unknown;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface ResolveGateRequest {
  decision: "APPROVE" | "REJECT" | "OVERRIDE";
  payload?: Record<string, unknown>;
  reason_comment: string;
}

export interface ResolveGateResponse {
  gate_id: string;
  status: "RESOLVED";
  decision: string;
  payload: unknown;
  resolved_by: string;
  resolved_at: string;
}

export function fetchGates(): Promise<GateListResponse> {
  return request<GateListResponse>(`${API_V1}/gates`);
}

export function fetchGateDetail(gateId: string): Promise<GateDetailResponse> {
  return request<GateDetailResponse>(`${API_V1}/gates/${gateId}`);
}

export function resolveGate(gateId: string, body: ResolveGateRequest): Promise<ResolveGateResponse> {
  return request<ResolveGateResponse>(`${API_V1}/gates/${gateId}/resolve`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchResolvedGateCount(hours = 24): Promise<{ count: number }> {
  return request<{ count: number }>(`${API_V1}/gates?resolved_since=${hours}h`);
}
