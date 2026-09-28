import { usePipelineStageCounts } from "../api/hooks";
import { PIPELINE_STAGE_STATUSES } from "../api/client";
import { getToken } from "../api/client";

const STAGE_LABELS: Record<string, string> = {
  INTAKE: "Intake",
  PARSED: "Parsed",
  ELIGIBILITY_DONE: "Eligibility",
  NEEDS_REVIEW: "Needs Review",
  SCORED: "Scored",
  SHORTLISTED: "Shortlisted",
  VERIFIED: "Verified",
  SELECTED: "Selected",
};

export function PipelineStrip() {
  const results = usePipelineStageCounts();
  const hasToken = !!getToken();

  if (!hasToken) {
    return (
      <div className="rounded-lg border border-border-soft bg-surface p-4 text-sm text-text-secondary">
        Pipeline stages will appear here once you connect with a dev token above.
      </div>
    );
  }

  const anyLoading = results.some((r) => r.isLoading);
  const anyLoaded = results.some((r) => r.data);

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Live Pipeline</h2>
        {anyLoading && !anyLoaded && <span className="text-xs text-text-secondary">Loading…</span>}
      </div>
      <div className="grid grid-cols-4 gap-3 md:grid-cols-8">
        {PIPELINE_STAGE_STATUSES.map((status, i) => {
          const result = results[i];
          const count = result.data?.count ?? 0;
          const isReview = status === "NEEDS_REVIEW";
          const isSelected = status === "SELECTED";
          return (
            <div
              key={status}
              className={`flex flex-col items-center rounded-md border p-3 ${
                isReview && count > 0
                  ? "border-attention bg-attention/5"
                  : isSelected && count > 0
                  ? "border-success bg-success/5"
                  : "border-border-soft"
              }`}
            >
              <span
                className={`text-2xl font-semibold ${
                  isReview && count > 0
                    ? "text-attention"
                    : isSelected && count > 0
                    ? "text-success"
                    : "text-agent"
                }`}
              >
                {result.isError ? "—" : count}
              </span>
              <span className="mt-1 text-center text-xs text-text-secondary">{STAGE_LABELS[status]}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-text-secondary">
        Counts reflect up to 200 candidates per stage in the current org — an approximation until a dedicated
        funnel/stats endpoint is wired in.
      </p>
    </div>
  );
}
