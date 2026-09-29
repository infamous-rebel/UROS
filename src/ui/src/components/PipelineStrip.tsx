/**
 * PipelineStrip — Quest 05 Part 3.
 *
 * Live pipeline stage counts with clickable navigation to filtered candidate
 * lists. NEEDS_REVIEW pulses amber when count > 0 to draw attention.
 */
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
        Pipeline stages will appear here once you sign in.
      </div>
    );
  }

  const anyLoading = results.some((r) => r.isLoading);
  const anyLoaded = results.some((r) => r.data);

  function handleStageClick(status: string) {
    // Navigate to the candidates view with a status filter.
    // Part 4 will implement CandidateList which consumes this hash.
    window.location.hash = `#/candidates?status=${status}`;
  }

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
          const hasCount = count > 0;

          return (
            <button
              key={status}
              onClick={() => hasCount && handleStageClick(status)}
              disabled={!hasCount}
              className={`flex flex-col items-center rounded-md border p-3 transition-all ${
                isReview && hasCount
                  ? "border-attention bg-attention/5 animate-pulse-slow"
                  : isSelected && hasCount
                  ? "border-success bg-success/5"
                  : "border-border-soft"
              } ${hasCount ? "cursor-pointer hover:shadow-md" : "cursor-default opacity-60"}`}
            >
              <span
                className={`text-2xl font-semibold ${
                  isReview && hasCount
                    ? "text-attention"
                    : isSelected && hasCount
                    ? "text-success"
                    : "text-agent"
                }`}
              >
                {result.isError ? "—" : count}
              </span>
              <span className="mt-1 text-center text-xs text-text-secondary">{STAGE_LABELS[status]}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-text-secondary">
        Click a stage to view candidates. Counts refresh automatically.
      </p>
    </div>
  );
}
