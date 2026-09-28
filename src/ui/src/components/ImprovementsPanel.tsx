import { useImprovementSuggestions, useUpdateSuggestion } from "../api/hooks_hr";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";

export function ImprovementsPanel() {
  const { data, isLoading, isError } = useImprovementSuggestions();
  const update = useUpdateSuggestion();

  if (!getToken()) return <EmptyState message="Connect with a dev token to view improvement suggestions." />;
  if (isLoading) return <EmptyState message="Loading suggestions…" />;
  if (isError) return <EmptyState message="Could not reach the improvement advisor API." tone="danger" />;
  if (!data || data.suggestions.length === 0) return <EmptyState message="No improvement suggestions generated yet." tone="success" />;

  return (
    <ul className="space-y-2">
      {data.suggestions.map((s) => (
        <li key={s.suggestion_id} className="rounded-md border border-border-soft p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-attention">{s.gap_type}</span>
            <span className="text-text-secondary">{s.status} · {s.source}</span>
          </div>
          <p className="mt-1 text-sm text-text-primary">{s.suggestion}</p>
          <div className="mt-2 flex gap-2">
            {s.status === "SUGGESTED" && (
              <button
                onClick={() => update.mutate({ id: s.suggestion_id, status: "MANAGER_APPROVED" })}
                className="rounded bg-human px-2 py-1 text-xs font-medium text-white"
              >
                Approve
              </button>
            )}
            {s.status === "MANAGER_APPROVED" && (
              <button
                onClick={() => {
                  const assignee = window.prompt("Assign to user ID (HR staff):");
                  if (assignee) update.mutate({ id: s.suggestion_id, status: "HR_ASSIGNED", assigned_to: assignee });
                }}
                className="rounded bg-agent px-2 py-1 text-xs font-medium text-white"
              >
                HR: Assign
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
