import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, API_V1, getToken } from "../api/client";

const enabled = () => !!getToken();

export const SOURCE_PLATFORMS = ["Teletalk", "bdjobs", "LinkedIn", "Email", "WhatsApp", "CSV"] as const;
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

export interface UnderperformanceThresholds {
  min_pass_rate?: number;
  min_selection_rate?: number;
  max_cost_per_quality_hire?: number;
}

export interface QualityHireDefinition {
  hire_statuses: string[];
  min_score: number | null;
  thresholds: UnderperformanceThresholds;
}

export interface AnalyticsConfig {
  config_id: string;
  org_id: string;
  quality_hire_definition: QualityHireDefinition;
  default_time_window_days: number;
  created_at: string;
  updated_at: string;
}

export interface UnderperformanceFlag {
  source_platform: SourcePlatform;
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}

export interface SourceEffectivenessMetrics {
  source_platform: SourcePlatform;
  total_candidates: number;
  eligible_pass_count: number;
  interview_count: number;
  selection_count: number;
  pass_rate: number;
  interview_rate: number;
  selection_rate: number;
}

export interface SourceEffectivenessReport {
  org_id: string;
  window_start: string;
  window_end: string;
  circular_id: string | null;
  sources: SourceEffectivenessMetrics[];
  flags: UnderperformanceFlag[];
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}

export interface FunnelStage {
  stage: "APPLIED" | "ELIGIBLE" | "SCORED" | "SHORTLISTED" | "COMMUNICATED" | "SELECTED";
  count: number;
}

export interface FunnelAnalysisReport {
  org_id: string;
  circular_id: string;
  stages: FunnelStage[];
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}

export interface QualityHireSourceCost {
  source_platform: SourcePlatform;
  total_cost: number;
  quality_hire_count: number;
  cost_per_quality_hire: number | null;
}

export interface QualityHireReport {
  org_id: string;
  window_start: string;
  window_end: string;
  quality_hire_definition: QualityHireDefinition;
  sources: QualityHireSourceCost[];
  flags: UnderperformanceFlag[];
  reason_code: string;
  reason_description: string;
  evidence: Record<string, unknown>;
}

/** Effective analytics config for the org (configured or system default) — see GET /analytics/config. */
export function useAnalyticsConfig() {
  return useQuery({
    queryKey: ["analytics-config"],
    queryFn: () =>
      authedRequest<{
        config: AnalyticsConfig | null;
        effective_quality_hire_definition: QualityHireDefinition;
        effective_default_time_window_days: number;
        is_system_default: boolean;
      }>(`${API_V1}/analytics/config`),
    enabled: enabled(),
  });
}

/** Create/update the org's analytics config — see POST /analytics/configure. */
export function useConfigureAnalytics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { quality_hire_definition: QualityHireDefinition; default_time_window_days: number }) =>
      authedRequest<{ config: AnalyticsConfig }>(`${API_V1}/analytics/configure`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analytics-config"] });
      qc.invalidateQueries({ queryKey: ["analytics-sources"] });
      qc.invalidateQueries({ queryKey: ["analytics-quality-hire"] });
    },
  });
}

/** Record a source/campaign cost entry — see POST /analytics/source-costs. */
export function useAddSourceCost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { source_platform: SourcePlatform; campaign_id?: string; cost: number; effective_date: string }) =>
      authedRequest<{ source_cost: unknown }>(`${API_V1}/analytics/source-costs`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics-quality-hire"] }),
  });
}

/** Source effectiveness summary — see GET /analytics/sources. */
export function useSourceEffectiveness(params: { circular_id?: string; time_window_days?: number } = {}) {
  return useQuery({
    queryKey: ["analytics-sources", params],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.circular_id) q.set("circular_id", params.circular_id);
      if (params.time_window_days) q.set("time_window_days", String(params.time_window_days));
      const qs = q.toString();
      return authedRequest<SourceEffectivenessReport>(`${API_V1}/analytics/sources${qs ? `?${qs}` : ""}`);
    },
    enabled: enabled(),
  });
}

/** Funnel analysis for one circular — see GET /analytics/funnel. */
export function useFunnelAnalysis(circularId: string | null) {
  return useQuery({
    queryKey: ["analytics-funnel", circularId],
    queryFn: () => authedRequest<FunnelAnalysisReport>(`${API_V1}/analytics/funnel?circular_id=${encodeURIComponent(circularId as string)}`),
    enabled: enabled() && !!circularId,
  });
}

/** Cost per quality hire per source — see GET /analytics/quality-hire. */
export function useQualityHireCost(params: { time_window_days?: number; source_platform?: SourcePlatform } = {}) {
  return useQuery({
    queryKey: ["analytics-quality-hire", params],
    queryFn: () => {
      const q = new URLSearchParams();
      if (params.time_window_days) q.set("time_window_days", String(params.time_window_days));
      if (params.source_platform) q.set("source_platform", params.source_platform);
      const qs = q.toString();
      return authedRequest<QualityHireReport>(`${API_V1}/analytics/quality-hire${qs ? `?${qs}` : ""}`);
    },
    enabled: enabled(),
  });
}

/**
 * Downloads one analytics report as a file — GET /analytics/export
 * needs the bearer token, so this is a manual authed fetch + blob
 * download rather than a plain `<a href>` navigation. Mirrors
 * downloadExamExport in hooks_exams.ts.
 */
export async function downloadAnalyticsExport(
  report: "sources" | "funnel" | "quality-hire",
  format: "pdf" | "csv" | "excel",
  params: { circular_id?: string; time_window_days?: number } = {}
): Promise<void> {
  const token = getToken();
  const q = new URLSearchParams({ report, format });
  if (params.circular_id) q.set("circular_id", params.circular_id);
  if (params.time_window_days) q.set("time_window_days", String(params.time_window_days));

  const res = await fetch(`${API_V1}/analytics/export?${q.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Export failed with status ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ext = format === "excel" ? "xlsx" : format;
  a.download = `${report}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}
