import { useState } from "react";
import { useAppeals, useResolveAppeal } from "../api/hooks_hr";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";

export function AppealsPanel() {
  const { data, isLoading, isError } = useAppeals();
  const resolve = useResolveAppeal();
  const [resolutionDrafts, setResolutionDrafts] = useState<Record<string, string>>({});

  if (!getToken()) return <EmptyState message="Connect with a dev token to view appeals." />;
  if (isLoading) return <EmptyState message="Loading appeals…" />;
  if (isError) return <EmptyState message="Could not reach the appeals API." tone="danger" />;
  if (!data || data.appeals.length === 0) return <EmptyState message="No appeals submitted yet." tone="success" />;

  return (
    <div className="space-y-2">
      {data.appeals.map((a) => (
        <div key={a.appeal_id} className="rounded-md border border-border-soft p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-text-primary">{a.category}</span>
            <span className="text-xs text-attention">{a.status}</span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">{a.reason_text}</p>
          {a.status !== "RESOLVED" && (
            <div className="mt-2 flex gap-2">
              <input
                placeholder="Resolution reason (mandatory)"
                value={resolutionDrafts[a.appeal_id] ?? ""}
                onChange={(e) => setResolutionDrafts((s) => ({ ...s, [a.appeal_id]: e.target.value }))}
                className="flex-1 rounded border border-border-soft bg-background px-2 py-1 text-xs"
              />
              <button
                disabled={!resolutionDrafts[a.appeal_id]}
                onClick={() =>
                  resolve.mutate({ id: a.appeal_id, status: "RESOLVED", resolution: resolutionDrafts[a.appeal_id] })
                }
                className="rounded bg-human px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
              >
                Resolve
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
