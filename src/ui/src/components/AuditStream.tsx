import { useAuditStream } from "../api/hooks";
import { getToken, ApiError, API_V1 } from "../api/client";
import { DownloadButton } from "./DownloadButton";
import { ReasonCode } from "./ReasonCode";

export function AuditStream() {
  const { data, isLoading, isError, error } = useAuditStream();
  const hasToken = !!getToken();

  const forbidden = error instanceof ApiError && error.status === 403;

  return (
    <div className="flex h-full flex-col rounded-lg border border-border-soft bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold text-text-primary">Audit Stream</h2>

      <div className="mb-2 flex gap-2">
        <DownloadButton endpoint={`${API_V1}/audit-logs/export?format=csv`} format="csv" filename="audit-log.csv" label="Export CSV" size="sm" />
        <DownloadButton endpoint={`${API_V1}/audit-logs/export?format=json`} format="json" filename="audit-log.json" label="Export JSON" size="sm" />
      </div>

      {!hasToken ? (
        <EmptyState message="Connect with a dev token to view the audit trail." />
      ) : isLoading ? (
        <EmptyState message="Loading recent activity…" />
      ) : forbidden ? (
        <EmptyState message="This account's role doesn't have audit-log access (Admin or Auditor only)." />
      ) : isError ? (
        <EmptyState message="Could not reach the audit log API." tone="danger" />
      ) : !data || data.entries.length === 0 ? (
        <EmptyState message="No audit activity recorded yet for this organization." />
      ) : (
        <ul className="flex-1 space-y-2 overflow-auto">
          {data.entries.map((entry) => (
            <li key={entry.audit_id} className="rounded-md border border-border-soft p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium text-text-primary">{entry.action}</span>
                <span className="text-text-secondary">{new Date(entry.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="mt-1 text-text-secondary">
                <ActorBadge actor={entry.agent_or_user} /> · {entry.entity_type} · {entry.entity_id}
              </div>
              {entry.reason_code && (
                <div className="mt-1"><ReasonCode code={entry.reason_code} size="sm" /></div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActorBadge({ actor }: { actor: string }) {
  const isAgent = /Agent|Orchestrator|Scheduler|Connector|System/i.test(actor);
  return (
    <span className={`font-medium ${isAgent ? "text-agent" : "text-human"}`}>{actor}</span>
  );
}

function EmptyState({ message, tone = "neutral" }: { message: string; tone?: "neutral" | "danger" }) {
  const color = tone === "danger" ? "text-danger" : "text-text-secondary";
  return (
    <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border-soft py-8 text-center">
      <p className={`px-4 text-sm ${color}`}>{message}</p>
    </div>
  );
}
