/**
 * Quest 05 Part 2 — CommandBar API hooks.
 *
 * React-query hooks for the CommandBar features: org switcher, dashboard
 * summary, circular selector, notification bell, and global search.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authedRequest, setAccessToken } from "./client";

// ─── Types ───────────────────────────────────────────────────────────
export interface OrgEntry {
  org_id: string;
  name: string;
  role: string;
  active: boolean;
}

export interface DashboardSummary {
  auto_pass: number;
  auto_fail: number;
  needs_review: number;
  overdue_gates: number;
}

export interface CircularEntry {
  circular_id: string;
  candidates: number;
}

export interface NotificationItem {
  gate_id?: string;
  gate_type?: string;
  batch_id?: string;
  created_at?: string;
  task_id?: string;
  title?: string;
  due_date?: string;
  priority?: string;
  message_id?: string;
  channel?: string;
  template_code?: string;
  sent_at?: string;
}

export interface NotificationGroups {
  gates: { count: number; items: NotificationItem[] };
  tasks: { count: number; items: NotificationItem[] };
  deliveries: { count: number; items: NotificationItem[] };
}

export interface Notifications {
  total: number;
  groups: NotificationGroups;
}

export interface SearchResult {
  id: string;
  title: string;
  subtitle: string;
  category: "candidate" | "rule" | "gate" | "audit";
}

// ─── API functions ───────────────────────────────────────────────────
export async function fetchMyOrgs(): Promise<OrgEntry[]> {
  const res = await authedRequest<{ orgs: OrgEntry[] }>("/auth/orgs");
  return res.orgs;
}

export async function switchOrgApi(orgId: string): Promise<{ access_token: string; user: any }> {
  const res = await authedRequest<{ access_token: string; user: any }>(`/auth/orgs/${orgId}/switch`, {
    method: "POST",
  });
  return res;
}

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  return authedRequest<DashboardSummary>("/dashboard/summary");
}

export async function fetchCirculars(): Promise<CircularEntry[]> {
  const res = await authedRequest<{ circulars: CircularEntry[] }>("/dashboard/circulars");
  return res.circulars;
}

export async function fetchNotifications(): Promise<Notifications> {
  return authedRequest<Notifications>("/notifications");
}

export async function searchApi(q: string): Promise<SearchResult[]> {
  const res = await authedRequest<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`);
  return res.results;
}

// ─── Hooks ───────────────────────────────────────────────────────────
export function useMyOrgs() {
  return useQuery({
    queryKey: ["my-orgs"],
    queryFn: fetchMyOrgs,
    staleTime: 60_000,
  });
}

export function useSwitchOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: switchOrgApi,
    onSuccess: (data) => {
      // Update the access token and invalidate org-related queries.
      setAccessToken(data.access_token);
      queryClient.invalidateQueries({ queryKey: ["my-orgs"] });
      queryClient.invalidateQueries({ queryKey: ["health"] });
      // Invalidate all dashboard data — the user switched orgs.
      queryClient.clear();
    },
  });
}

export function useDashboardSummary() {
  return useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: fetchDashboardSummary,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

export function useCirculars() {
  return useQuery({
    queryKey: ["circulars"],
    queryFn: fetchCirculars,
    staleTime: 60_000,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: fetchNotifications,
    refetchInterval: () => {
      // Poll faster when the window is focused, slower when backgrounded.
      if (typeof document !== "undefined" && document.hidden) {
        return 60_000;
      }
      return 15_000;
    },
    staleTime: 5_000,
  });
}

export function useGlobalSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    queryFn: () => searchApi(q),
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
}
