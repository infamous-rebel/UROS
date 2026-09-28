import { useNeedsReviewQueue } from "../api/hooks";
import { getToken } from "../api/client";

export function DecisionQueue() {
  const { data, isLoading, isError } = useNeedsReviewQueue();
  const hasToken = !!getToken();

  return (
    <div className="flex h-full flex-col rounded-lg border border-border-soft bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Decision Queue</h2>
        {data && <span className="text-xs text-text-secondary">{data.count} needing review</span>}
      </div>

      {!hasToken ? (
        <EmptyState message="Connect with a dev token to load the decision queue." />
      ) : isLoading ? (
        <EmptyState message="Loading candidates needing review…" />
      ) : isError ? (
        <EmptyState message="Could not reach the candidates API. Check the token and API origin." tone="danger" />
      ) : !data || data.candidates.length === 0 ? (
        <EmptyState message="All clear — no candidates currently need human review." tone="success" />
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-soft text-xs uppercase tracking-wide text-text-secondary">
                <th className="py-2 pr-3">Candidate</th>
                <th className="py-2 pr-3">Circular</th>
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Confidence</th>
                <th className="py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.candidates.map((c) => (
                <tr key={c.candidate_id} className="border-b border-border-soft last:border-0 hover:bg-background">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-text-primary">{c.full_name || "—"}</div>
                    <div className="text-xs text-text-secondary">{c.candidate_id}</div>
                  </td>
                  <td className="py-2 pr-3 text-text-secondary">{c.job_circular_id ?? "—"}</td>
                  <td className="py-2 pr-3 text-text-secondary">{c.source_platform ?? "—"}</td>
                  <td className="py-2 pr-3">
                    <ConfidenceBadge confidence={c.data_confidence} />
                  </td>
                  <td className="py-2 text-text-secondary">{new Date(c.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  const color =
    confidence === "Low" ? "text-attention" : confidence === "Medium" ? "text-text-secondary" : "text-agent";
  return <span className={`text-xs font-medium ${color}`}>{confidence ?? "Unknown"}</span>;
}

function EmptyState({ message, tone = "neutral" }: { message: string; tone?: "neutral" | "danger" | "success" }) {
  const color = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-text-secondary";
  return (
    <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border-soft py-8">
      <p className={`text-sm ${color}`}>{message}</p>
    </div>
  );
}
