import { useState } from "react";
import {
  useFraudChecks,
  useRunFraudDetection,
  useFraudFlags,
  useResolveFraudFlag,
  FraudSeverity,
  FraudFlagStatus,
  FraudRunResult,
} from "../hooks/hooks_fraud";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";
import { ReasonCode } from "./ReasonCode";

const SEVERITY_BADGE: Record<FraudSeverity, string> = {
  LOW: "bg-border-soft text-text-secondary",
  MEDIUM: "bg-attention text-white",
  HIGH: "bg-danger text-white",
};

const STATUS_BADGE: Record<FraudFlagStatus, string> = {
  OPEN: "bg-attention text-white",
  CONFIRMED: "bg-danger text-white",
  FALSE_POSITIVE: "bg-success text-white",
  ESCALATED: "bg-human text-white",
};

function SeverityBadge({ severity }: { severity: FraudSeverity }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_BADGE[severity]}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: FraudFlagStatus }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[status]}`}>{status.replace("_", " ")}</span>;
}

function FlagReviewRow({ flagId, candidateId }: { flagId: string; candidateId: string }) {
  const resolve = useResolveFraudFlag(candidateId);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<"CONFIRMED" | "FALSE_POSITIVE" | "ESCALATED" | null>(null);

  const submit = (resolution: "CONFIRMED" | "FALSE_POSITIVE" | "ESCALATED") => {
    if (!reason.trim()) {
      setPending(resolution);
      return;
    }
    resolve.mutate({ flagId, resolution, resolution_reason: reason.trim() });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border-soft pt-2">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Mandatory reason for this resolution…"
        rows={2}
        className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
      />
      {pending && !reason.trim() && <div className="text-xs text-danger">A reason is required before {pending}.</div>}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => submit("CONFIRMED")} className="rounded border border-danger px-3 py-1.5 text-xs font-medium text-danger">
          Confirm Fraud
        </button>
        <button
          onClick={() => submit("FALSE_POSITIVE")}
          className="rounded bg-human px-3 py-1.5 text-xs font-medium text-white"
        >
          Mark False Positive
        </button>
        <button
          onClick={() => submit("ESCALATED")}
          className="rounded border border-attention px-3 py-1.5 text-xs font-medium text-attention"
        >
          Escalate
        </button>
      </div>
    </div>
  );
}

function CandidateFlagsView({ candidateId }: { candidateId: string }) {
  const { data, isLoading, isError } = useFraudFlags(candidateId);

  if (isLoading) return <EmptyState message="Loading flags…" />;
  if (isError) return <EmptyState message="Could not reach the fraud API." tone="danger" />;
  if (!data || data.flags.length === 0) {
    return <EmptyState message={`No fraud flags on file for ${candidateId}. Every check passed, or it hasn't been run yet.`} tone="success" />;
  }

  return (
    <div className="flex flex-col gap-3">
      {data.flags.map((flag) => (
        <div key={flag.flag_id} className="rounded-lg border border-border-soft bg-surface p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-text-primary">{flag.check_type.replace(/_/g, " ")}</div>
              <div className="mt-1 flex items-center gap-2">
                <SeverityBadge severity={flag.severity} />
                <StatusBadge status={flag.status} />
                <span className="text-[11px] text-text-secondary">{new Date(flag.detected_at).toLocaleString()}</span>
              </div>
            </div>
          </div>
          <div className="mt-2 text-xs text-text-primary">{flag.reason_description}</div>
          <div className="mt-1"><ReasonCode code={flag.reason_code} size="sm" /></div>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-agent underline">Why? (evidence)</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-2 text-[11px] text-text-secondary">
              {JSON.stringify(flag.evidence, null, 2)}
            </pre>
          </details>
          {flag.status === "OPEN" ? (
            <FlagReviewRow flagId={flag.flag_id} candidateId={candidateId} />
          ) : (
            <div className="mt-2 border-t border-border-soft pt-2 text-[11px] text-text-secondary">
              Resolved as <span className="font-medium text-text-primary">{flag.resolution}</span> by {flag.reviewed_by ?? "—"}
              {flag.resolution_reason ? `: "${flag.resolution_reason}"` : ""}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RunResultsTable({ results, onSelect }: { results: FraudRunResult[]; onSelect: (candidateId: string) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-surface">
      <table className="w-full text-left text-xs">
        <thead className="bg-background">
          <tr className="text-text-secondary">
            <th className="px-3 py-2">Candidate</th>
            <th className="px-3 py-2">Checks Run</th>
            <th className="px-3 py-2">Flags</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.candidate_id} className="border-t border-border-soft">
              <td className="px-3 py-2 text-text-primary">{r.candidate_id}</td>
              <td className="px-3 py-2 text-text-secondary">{r.checks_run}</td>
              <td className="px-3 py-2">
                {r.flags_created.length === 0 ? (
                  <span className="text-success">0</span>
                ) : (
                  <span className="font-medium text-attention">{r.flags_created.length}</span>
                )}
              </td>
              <td className="px-3 py-2">{r.error ? <span className="text-danger">{r.error}</span> : <span className="text-success">Processed</span>}</td>
              <td className="px-3 py-2">
                <button onClick={() => onSelect(r.candidate_id)} className="text-agent underline">
                  Review Flags
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FraudDetectionPanel() {
  const { data: checksData, isLoading: checksLoading, isError: checksError } = useFraudChecks();
  const run = useRunFraudDetection();
  const [candidateIdsInput, setCandidateIdsInput] = useState("");
  const [circularIdInput, setCircularIdInput] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [lookupCandidateId, setLookupCandidateId] = useState("");

  if (!getToken()) return <EmptyState message="Connect with a dev token to use fraud detection." />;

  const triggerRun = () => {
    const candidate_ids = candidateIdsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const circular_id = circularIdInput.trim() || undefined;
    if (candidate_ids.length === 0 && !circular_id) return;
    run.mutate({ candidate_ids: candidate_ids.length ? candidate_ids : undefined, circular_id });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Active checks — always populated (system defaults) so this is never dead space */}
      <div>
        <div className="mb-2 text-xs font-semibold text-text-primary">Active Fraud Checks</div>
        {checksLoading && <EmptyState message="Loading checks…" />}
        {checksError && <EmptyState message="Could not reach the fraud API." tone="danger" />}
        {checksData && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {checksData.checks.map((c) => (
              <div key={c.check_type} className="rounded-lg border border-border-soft bg-surface p-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium text-text-primary">{c.check_type.replace(/_/g, " ")}</div>
                  {c.is_knockout && <span className="rounded bg-danger px-1.5 py-0.5 text-[10px] text-white">Knockout</span>}
                </div>
                <div className="mt-1 text-[11px] text-text-secondary">{c.name}</div>
                <div className="mt-1 text-[10px] text-text-secondary">
                  {c.is_system_default ? "System default configuration" : "Org-configured"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Run detection */}
      <div className="rounded-lg border border-border-soft bg-surface p-3">
        <div className="mb-2 text-xs font-semibold text-text-primary">Run Fraud Detection</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={candidateIdsInput}
            onChange={(e) => setCandidateIdsInput(e.target.value)}
            placeholder="Candidate IDs, comma-separated"
            className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
          />
          <input
            value={circularIdInput}
            onChange={(e) => setCircularIdInput(e.target.value)}
            placeholder="or Circular ID (runs whole batch)"
            className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
          />
          <button
            disabled={run.isPending}
            onClick={triggerRun}
            className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {run.isPending ? "Running…" : "Run Detection"}
          </button>
        </div>
        {run.isError && <div className="mt-2 text-xs text-danger">{(run.error as Error)?.message ?? "Run failed."}</div>}
      </div>

      {/* Run results */}
      {run.data && run.data.results.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold text-text-primary">Run Results ({run.data.count})</div>
          <RunResultsTable results={run.data.results} onSelect={setSelectedCandidateId} />
        </div>
      )}

      {/* Direct candidate flag lookup */}
      <div className="rounded-lg border border-border-soft bg-surface p-3">
        <div className="mb-2 text-xs font-semibold text-text-primary">Look Up Flags for a Candidate</div>
        <div className="flex gap-2">
          <input
            value={lookupCandidateId}
            onChange={(e) => setLookupCandidateId(e.target.value)}
            placeholder="Candidate ID"
            className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
          />
          <button
            onClick={() => setSelectedCandidateId(lookupCandidateId.trim() || null)}
            className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white"
          >
            View Flags
          </button>
        </div>
      </div>

      {selectedCandidateId ? (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold text-text-primary">Flags for {selectedCandidateId}</div>
            <button onClick={() => setSelectedCandidateId(null)} className="text-xs text-text-secondary">
              Close
            </button>
          </div>
          <CandidateFlagsView candidateId={selectedCandidateId} />
        </div>
      ) : (
        <EmptyState message="Run detection or look up a candidate ID to see flagged results and evidence." />
      )}
    </div>
  );
}
