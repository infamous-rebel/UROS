import { useQuery, useQueries } from "@tanstack/react-query";
import {
  fetchHealth,
  fetchCandidatesByStatus,
  fetchAuditLogs,
  getToken,
  PIPELINE_STAGE_STATUSES,
} from "./client";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5_000,
    retry: 1,
  });
}

export function useNeedsReviewQueue() {
  return useQuery({
    queryKey: ["candidates", "NEEDS_REVIEW"],
    queryFn: () => fetchCandidatesByStatus("NEEDS_REVIEW"),
    refetchInterval: 5_000,
    enabled: !!getToken(),
    retry: 1,
  });
}

/**
 * Live pipeline strip stage counts. Reads `.count` from each per-status
 * candidates query (capped at limit=200 per stage). This is an
 * approximation, not a true total — a dedicated funnel/stats endpoint
 * (file 20 §10.5) is the correct long-term source and should replace
 * this once wired into the UI in a later phase.
 */
export function usePipelineStageCounts() {
  return useQueries({
    queries: PIPELINE_STAGE_STATUSES.map((status) => ({
      queryKey: ["candidates", status, "count"],
      queryFn: () => fetchCandidatesByStatus(status, 200),
      refetchInterval: 8_000,
      enabled: !!getToken(),
      retry: 1,
    })),
  });
}

export function useAuditStream() {
  return useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => fetchAuditLogs(15),
    refetchInterval: 7_000,
    enabled: !!getToken(),
    retry: false, // 403 for non-Auditor/Admin roles is expected, not transient
  });
}
