import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchGates, resolveGate, getToken, type ResolveGateRequest } from "../api/client";

/**
 * Polls GET /api/v1/gates for PENDING gates. Refetches every 5s so the
 * inbox stays live without manual refresh.
 */
export function usePendingGates() {
  return useQuery({
    queryKey: ["gates", "pending"],
    queryFn: fetchGates,
    refetchInterval: 5_000,
    enabled: !!getToken(),
    retry: 1,
  });
}

/**
 * Resolves a gate via POST /api/v1/gates/:gateId/resolve.
 * Invalidates the pending gates list on success so the row disappears.
 */
export function useResolveGate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ gateId, body }: { gateId: string; body: ResolveGateRequest }) =>
      resolveGate(gateId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["gates"] });
    },
  });
}
