/**
 * Minimal API client for the UROS dashboard shell.
 *
 * Assumption (stated once): there is no login UI in this first mount —
 * Phase 5 scope is the dashboard shell, not authentication UX. A JWT
 * (issued by the existing backend `authenticate` middleware) is pasted
 * into the Command Bar and persisted to localStorage as a dev affordance.
 * A real login flow replaces this in a later phase without changing the
 * hooks below, since they only care about "is a token present".
 */

const API_ORIGIN = (import.meta as any).env?.VITE_API_ORIGIN ?? "http://localhost:3000";
const API_V1 = `${API_ORIGIN}/api/v1`;
export { API_V1 };
const TOKEN_STORAGE_KEY = "uros_dev_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request failed with status ${res.status}`);
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
