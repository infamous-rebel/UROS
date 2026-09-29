/**
 * DecisionQueue — Quest 05 Part 3.
 *
 * Expandable rows with checkboxes for batch selection, filter chips for
 * failure categories, batch action bar, and enhanced columns showing
 * reason code, evidence snippet, recommended action, and time-in-queue.
 * Live empty state reports candidates processed in the last hour.
 */
import { useState, useMemo, useCallback } from "react";
import { useNeedsReviewQueue } from "../api/hooks";
import { getToken, type CandidateSummary } from "../api/client";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";

// ─── Filter chip categories ──────────────────────────────────────────
type FilterCategory = "all" | "auto_fail" | "borderline" | "ocr_issue" | "verification" | "age";

const FILTER_CHIPS: { key: FilterCategory; label: string }[] = [
  { key: "all", label: "All" },
  { key: "auto_fail", label: "Auto-Fail" },
  { key: "borderline", label: "Borderline" },
  { key: "ocr_issue", label: "OCR Issue" },
  { key: "verification", label: "Verification Issue" },
  { key: "age", label: "Stale (>24h)" },
];

function categorize(c: CandidateSummary): FilterCategory[] {
  const cats: FilterCategory[] = ["all"];
  const rc = (c.reason_code ?? "").toUpperCase();
  if (rc.includes("FAIL") || rc.includes("INELIGIBLE")) cats.push("auto_fail");
  if (c.distance_to_threshold != null && Math.abs(c.distance_to_threshold) < 0.1) cats.push("borderline");
  if (rc.includes("OCR") || rc.includes("PARSE")) cats.push("ocr_issue");
  if (rc.includes("VERIFY") || rc.includes("DOCUMENT")) cats.push("verification");
  const ageMs = Date.now() - new Date(c.updated_at).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) cats.push("age");
  return cats;
}

function recommendedAction(c: CandidateSummary): string {
  const rc = (c.reason_code ?? "").toUpperCase();
  if (rc.includes("OCR") || rc.includes("PARSE")) return "Request clearer scan";
  if (rc.includes("VERIFY") || rc.includes("DOCUMENT")) return "Verify documents";
  if (rc.includes("FAIL") || rc.includes("INELIGIBLE")) return "Review eligibility";
  if (c.distance_to_threshold != null && Math.abs(c.distance_to_threshold) < 0.1) return "Borderline — manual call";
  return "Review & decide";
}

function timeInQueue(updatedAt: string): string {
  const ms = Date.now() - new Date(updatedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

// ─── Main component ──────────────────────────────────────────────────
export function DecisionQueue() {
  const { data, isLoading, isError } = useNeedsReviewQueue();
  const hasToken = !!getToken();

  const [activeFilter, setActiveFilter] = useState<FilterCategory>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const candidates = data?.candidates ?? [];

  // Filter candidates by active chip
  const filtered = useMemo(() => {
    if (activeFilter === "all") return candidates;
    return candidates.filter((c) => categorize(c).includes(activeFilter));
  }, [candidates, activeFilter]);

  // Counts per filter category
  const filterCounts = useMemo(() => {
    const counts: Record<FilterCategory, number> = { all: candidates.length, auto_fail: 0, borderline: 0, ocr_issue: 0, verification: 0, age: 0 };
    for (const c of candidates) {
      for (const cat of categorize(c)) {
        if (cat !== "all") counts[cat]++;
      }
    }
    return counts;
  }, [candidates]);

  // Recent processing count (updated in last hour)
  const processedLastHour = useMemo(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return candidates.filter((c) => new Date(c.updated_at).getTime() > oneHourAgo).length;
  }, [candidates]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === filtered.length) return new Set();
      return new Set(filtered.map((c) => c.candidate_id));
    });
  }, [filtered]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  // ─── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col rounded-lg border border-border-soft bg-surface p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">Decision Queue</h2>
        {data && (
          <span className="text-xs text-text-secondary">
            {data.count} needing review
          </span>
        )}
      </div>

      {/* Filter chips */}
      {candidates.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {FILTER_CHIPS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveFilter(key)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                activeFilter === key
                  ? "bg-agent text-white"
                  : "bg-background text-text-secondary hover:bg-border-soft"
              }`}
            >
              {label}
              {key !== "all" && filterCounts[key] > 0 && (
                <span className="ml-1 opacity-70">({filterCounts[key]})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Batch action bar */}
      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md bg-agent/5 px-3 py-2 text-sm">
          <span className="font-medium text-agent">{selected.size} selected</span>
          <div className="flex gap-2">
            <button className="rounded bg-success px-2 py-1 text-xs text-white hover:bg-success/80">
              Approve
            </button>
            <button className="rounded bg-danger px-2 py-1 text-xs text-white hover:bg-danger/80">
              Reject
            </button>
            <button className="rounded bg-attention px-2 py-1 text-xs text-white hover:bg-attention/80">
              Request Docs
            </button>
          </div>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-text-secondary hover:text-text-primary"
          >
            Clear
          </button>
        </div>
      )}

      {/* Content */}
      {!hasToken ? (
        <EmptyState message="Connect with a dev token to load the decision queue." />
      ) : isLoading ? (
        <EmptyState message="Loading candidates needing review…" />
      ) : isError ? (
        <EmptyState message="Could not reach the candidates API. Check the token and API origin." tone="danger" />
      ) : candidates.length === 0 ? (
        <EmptyState
          message={`All clear — no candidates currently need human review. ${processedLastHour} candidates processed in the last hour.`}
          tone="success"
        />
      ) : filtered.length === 0 ? (
        <EmptyState message={`No candidates match the "${activeFilter}" filter.`} tone="neutral" />
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-soft text-xs uppercase tracking-wide text-text-secondary">
                <th className="py-2 pr-2">
                  <input
                    type="checkbox"
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onChange={toggleAll}
                    className="rounded border-border-soft"
                  />
                </th>
                <th className="py-2 pr-3">Candidate</th>
                <th className="py-2 pr-3">Reason Code</th>
                <th className="py-2 pr-3">Evidence</th>
                <th className="py-2 pr-3">Action</th>
                <th className="py-2 pr-3">Queue Time</th>
                <th className="py-2">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <CandidateRow
                  key={c.candidate_id}
                  candidate={c}
                  isSelected={selected.has(c.candidate_id)}
                  isExpanded={expandedId === c.candidate_id}
                  onToggleSelect={() => toggleSelect(c.candidate_id)}
                  onToggleExpand={() => toggleExpand(c.candidate_id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Row with expandable detail ──────────────────────────────────────
function CandidateRow({
  candidate: c,
  isSelected,
  isExpanded,
  onToggleSelect,
  onToggleExpand,
}: {
  candidate: CandidateSummary;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
}) {
  const evidenceSnippet = c.input_value
    ? JSON.stringify(c.input_value).slice(0, 80)
    : "—";

  return (
    <>
      <tr
        className={`border-b border-border-soft last:border-0 cursor-pointer transition-colors ${
          isExpanded ? "bg-agent/5" : "hover:bg-background"
        }`}
        onClick={onToggleExpand}
      >
        <td className="py-2 pr-2" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="rounded border-border-soft"
          />
        </td>
        <td className="py-2 pr-3">
          <div className="flex items-center gap-1">
            <span className={`text-xs text-text-secondary transition-transform ${isExpanded ? "rotate-90" : ""}`}>
              <Icon icon={getIcon("Play")} size={10} tone="neutral" />
            </span>
            <div>
              <div className="font-medium text-text-primary">{c.full_name || "—"}</div>
              <div className="text-xs text-text-secondary">{c.candidate_id.slice(0, 8)}…</div>
            </div>
          </div>
        </td>
        <td className="py-2 pr-3">
          <ReasonBadge code={c.reason_code} />
        </td>
        <td className="py-2 pr-3">
          <span className="font-mono text-xs text-text-secondary" title={evidenceSnippet}>
            {evidenceSnippet}
          </span>
        </td>
        <td className="py-2 pr-3 text-xs text-agent font-medium">
          {recommendedAction(c)}
        </td>
        <td className="py-2 pr-3 text-xs text-text-secondary">
          {timeInQueue(c.updated_at)}
        </td>
        <td className="py-2">
          <ConfidenceBadge confidence={c.data_confidence} />
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-agent/5">
          <td colSpan={7} className="px-4 py-3">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="font-semibold text-text-primary">Full ID:</span>{" "}
                <span className="font-mono text-text-secondary">{c.candidate_id}</span>
              </div>
              <div>
                <span className="font-semibold text-text-primary">Source:</span>{" "}
                <span className="text-text-secondary">{c.source_platform ?? "—"}</span>
              </div>
              <div>
                <span className="font-semibold text-text-primary">Position:</span>{" "}
                <span className="text-text-secondary">{c.position_applied ?? "—"}</span>
              </div>
              <div>
                <span className="font-semibold text-text-primary">Circular:</span>{" "}
                <span className="text-text-secondary">{c.job_circular_id ?? "—"}</span>
              </div>
              {c.reason_code && (
                <div>
                  <span className="font-semibold text-text-primary">Reason:</span>{" "}
                  <span className="text-text-secondary">{c.reason_code}</span>
                </div>
              )}
              {c.eval_confidence != null && (
                <div>
                  <span className="font-semibold text-text-primary">Eval Confidence:</span>{" "}
                  <span className="text-text-secondary">{(c.eval_confidence * 100).toFixed(0)}%</span>
                </div>
              )}
              {c.distance_to_threshold != null && (
                <div>
                  <span className="font-semibold text-text-primary">Distance to Threshold:</span>{" "}
                  <span className="text-text-secondary">{c.distance_to_threshold.toFixed(3)}</span>
                </div>
              )}
              <div>
                <span className="font-semibold text-text-primary">Updated:</span>{" "}
                <span className="text-text-secondary">{new Date(c.updated_at).toLocaleString()}</span>
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                window.location.hash = `#/candidates?inspect=${c.candidate_id}`;
              }}
              className="mt-3 rounded bg-agent px-3 py-1 text-xs text-white hover:bg-agent/80"
            >
              View full profile →
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────
function ReasonBadge({ code }: { code?: string | null }) {
  if (!code) return <span className="text-xs text-text-secondary">—</span>;
  const upper = code.toUpperCase();
  let color = "bg-background text-text-secondary";
  if (upper.includes("FAIL") || upper.includes("INELIGIBLE")) color = "bg-danger/10 text-danger";
  else if (upper.includes("OCR") || upper.includes("PARSE")) color = "bg-attention/10 text-attention";
  else if (upper.includes("VERIFY")) color = "bg-agent/10 text-agent";
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${color}`}>
      {code}
    </span>
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
      <p className={`max-w-md text-center text-sm ${color}`}>{message}</p>
    </div>
  );
}
