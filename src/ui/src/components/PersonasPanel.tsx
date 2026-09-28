import { usePersonas } from "../api/hooks_hr";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";

export function PersonasPanel() {
  const { data, isLoading, isError } = usePersonas();

  if (!getToken()) return <EmptyState message="Connect with a dev token to view personas." />;
  if (isLoading) return <EmptyState message="Loading personas…" />;
  if (isError) return <EmptyState message="Could not reach the personas API." tone="danger" />;
  if (!data || data.personas.length === 0) return <EmptyState message="No departmental personas defined yet." />;

  return (
    <ul className="space-y-2">
      {data.personas.map((p) => (
        <li key={p.persona_id} className="rounded-md border border-border-soft p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-text-primary">{p.name}</span>
            <span className="text-xs text-text-secondary">v{p.version}</span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">{p.department} · {p.job_family}</p>
        </li>
      ))}
    </ul>
  );
}
