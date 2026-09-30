import { useState } from "react";
import {
  useRediscoveryConsent,
  useSetRediscoveryConsent,
  useRunRediscoveryMatch,
  useRediscoverySuggestions,
  useReviewRediscoverySuggestion,
  useSendRediscoveryOutreach,
  useRediscoveryOutreachHistory,
  RediscoveryConsentStatus,
  RediscoverySuggestion,
  RediscoverySuggestionStatus,
  RediscoveryOutreachChannel,
} from "../hooks/hooks_rediscovery";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";
import { ReasonCode } from "./ReasonCode";

const CONSENT_BADGE: Record<RediscoveryConsentStatus, string> = {
  OPTED_IN: "bg-success text-white",
  OPTED_OUT: "bg-danger text-white",
  NO_RECORD: "bg-border-soft text-text-secondary",
};

const STATUS_BADGE: Record<RediscoverySuggestionStatus, string> = {
  PENDING_REVIEW: "bg-attention text-white",
  APPROVED: "bg-success text-white",
  REJECTED: "bg-danger text-white",
};

function ConsentBadge({ status }: { status: RediscoveryConsentStatus }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${CONSENT_BADGE[status]}`}>{status.replace("_", " ")}</span>;
}

function StatusBadge({ status }: { status: RediscoverySuggestionStatus }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[status]}`}>{status.replace("_", " ")}</span>;
}

// ---------------------------------------------------------------------
// Consent section
// ---------------------------------------------------------------------

function ConsentLookup() {
  const [candidateIdInput, setCandidateIdInput] = useState("");
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  const { data, isLoading, isError } = useRediscoveryConsent(lookedUp);
  const setConsent = useSetRediscoveryConsent();

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">Candidate Consent</div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={candidateIdInput}
          onChange={(e) => setCandidateIdInput(e.target.value)}
          placeholder="Candidate ID"
          className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <button
          onClick={() => setLookedUp(candidateIdInput.trim() || null)}
          className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white"
        >
          Check Status
        </button>
      </div>

      {lookedUp && (
        <div className="mt-3 border-t border-border-soft pt-2">
          {isLoading && <EmptyState message="Loading consent status…" />}
          {isError && <EmptyState message="Could not reach the rediscovery API." tone="danger" />}
          {data && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-text-primary">{lookedUp}:</span>
              <ConsentBadge status={data.status} />
              {data.consent?.updated_at && (
                <span className="text-[11px] text-text-secondary">
                  Last updated {new Date(data.consent.updated_at).toLocaleString()}
                </span>
              )}
              <div className="flex gap-2">
                <button
                  disabled={setConsent.isPending}
                  onClick={() => setConsent.mutate({ candidate_id: lookedUp, opted_in: true })}
                  className="rounded bg-success px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  Record Opt-In
                </button>
                <button
                  disabled={setConsent.isPending}
                  onClick={() => setConsent.mutate({ candidate_id: lookedUp, opted_in: false })}
                  className="rounded border border-danger px-2.5 py-1 text-[11px] font-medium text-danger disabled:opacity-50"
                >
                  Record Opt-Out
                </button>
              </div>
            </div>
          )}
          {setConsent.isError && <div className="mt-2 text-xs text-danger">{(setConsent.error as Error)?.message}</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Run matching section
// ---------------------------------------------------------------------

function RunMatching({ onRun }: { onRun: (circularId: string) => void }) {
  const run = useRunRediscoveryMatch();
  const [targetCircularId, setTargetCircularId] = useState("");
  const [targetPosition, setTargetPosition] = useState("");
  const [personaId, setPersonaId] = useState("");
  const [minFitScore, setMinFitScore] = useState(50);
  const [minDaysSinceDecision, setMinDaysSinceDecision] = useState(90);
  const [requireOptIn, setRequireOptIn] = useState(true);
  const [maxCandidates, setMaxCandidates] = useState(200);

  const canRun = targetCircularId.trim().length > 0 && personaId.trim().length > 0;

  const trigger = () => {
    if (!canRun) return;
    run.mutate(
      {
        target_circular_id: targetCircularId.trim(),
        target_position: targetPosition.trim() || null,
        persona_id: personaId.trim(),
        min_fit_score: minFitScore,
        min_days_since_decision: minDaysSinceDecision,
        require_opt_in: requireOptIn,
        max_candidates: maxCandidates,
      },
      { onSuccess: () => onRun(targetCircularId.trim()) }
    );
  };

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">Run Talent Pool Matching</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <input
          value={targetCircularId}
          onChange={(e) => setTargetCircularId(e.target.value)}
          placeholder="Target circular ID (required)"
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <input
          value={targetPosition}
          onChange={(e) => setTargetPosition(e.target.value)}
          placeholder="Target position (optional)"
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <input
          value={personaId}
          onChange={(e) => setPersonaId(e.target.value)}
          placeholder="Persona ID (required)"
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <label className="flex items-center gap-2 text-[11px] text-text-secondary">
          Min fit score
          <input
            type="number"
            min={0}
            max={100}
            value={minFitScore}
            onChange={(e) => setMinFitScore(Number(e.target.value))}
            className="w-20 rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
          />
        </label>
        <label className="flex items-center gap-2 text-[11px] text-text-secondary">
          Cooldown (days)
          <input
            type="number"
            min={0}
            value={minDaysSinceDecision}
            onChange={(e) => setMinDaysSinceDecision(Number(e.target.value))}
            className="w-20 rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
          />
        </label>
        <label className="flex items-center gap-2 text-[11px] text-text-secondary">
          Max candidates
          <input
            type="number"
            min={1}
            value={maxCandidates}
            onChange={(e) => setMaxCandidates(Number(e.target.value))}
            className="w-20 rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
          />
        </label>
        <label className="flex items-center gap-2 text-[11px] text-text-secondary">
          <input type="checkbox" checked={requireOptIn} onChange={(e) => setRequireOptIn(e.target.checked)} />
          Require explicit opt-in
        </label>
      </div>
      <div className="mt-2">
        <button
          disabled={!canRun || run.isPending}
          onClick={trigger}
          className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {run.isPending ? "Running…" : "Run Matching"}
        </button>
      </div>
      {run.isError && <div className="mt-2 text-xs text-danger">{(run.error as Error)?.message ?? "Run failed."}</div>}
      {run.data && (
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border-soft pt-2 text-[11px] sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Considered" value={run.data.candidates_considered} />
          <Stat label="Suggested" value={run.data.suggestions_created.length} tone="success" />
          <Stat label="Below threshold" value={run.data.candidates_below_threshold} />
          <Stat label="Excl. consent" value={run.data.candidates_excluded_consent} />
          <Stat label="Excl. fraud" value={run.data.candidates_excluded_fraud} tone="danger" />
          <Stat label="Excl. recent" value={run.data.candidates_excluded_recent} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-text-primary";
  return (
    <div className="rounded bg-background p-2 text-center">
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
      <div className="text-text-secondary">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Suggestion review row
// ---------------------------------------------------------------------

function SuggestionRow({ suggestion }: { suggestion: RediscoverySuggestion }) {
  const review = useReviewRediscoverySuggestion();
  const sendOutreach = useSendRediscoveryOutreach();
  const [reason, setReason] = useState("");
  const [pendingAction, setPendingAction] = useState<"APPROVE" | "REJECT" | null>(null);
  const [channel, setChannel] = useState<RediscoveryOutreachChannel>("SMS");
  const [templateCode, setTemplateCode] = useState("REDISCOVERY_INVITE");

  const submitReview = (action: "APPROVE" | "REJECT") => {
    if (!reason.trim()) {
      setPendingAction(action);
      return;
    }
    review.mutate({ suggestionId: suggestion.suggestion_id, action, reason: reason.trim() });
  };

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-text-primary">{suggestion.candidate_id}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="rounded bg-agent px-1.5 py-0.5 text-[10px] font-medium text-white">Fit {suggestion.fit_score}/100</span>
            <StatusBadge status={suggestion.status} />
            <ConsentBadge status={suggestion.evidence.consent_status} />
            <span className="text-[11px] text-text-secondary">{new Date(suggestion.created_at).toLocaleString()}</span>
          </div>
        </div>
      </div>
      <div className="mt-2 text-xs text-text-primary">{suggestion.reason_description}</div>
      <div className="mt-1"><ReasonCode code={suggestion.reason_code} size="sm" /></div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-agent underline">Why? (evidence)</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-2 text-[11px] text-text-secondary">
          {JSON.stringify(suggestion.evidence, null, 2)}
        </pre>
      </details>

      {suggestion.status === "PENDING_REVIEW" && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border-soft pt-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Mandatory reason for approving or rejecting this suggestion…"
            rows={2}
            className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
          />
          {pendingAction && !reason.trim() && (
            <div className="text-xs text-danger">A reason is required before {pendingAction === "APPROVE" ? "approving" : "rejecting"}.</div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              disabled={review.isPending}
              onClick={() => submitReview("APPROVE")}
              className="rounded bg-success px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              disabled={review.isPending}
              onClick={() => submitReview("REJECT")}
              className="rounded border border-danger px-3 py-1.5 text-xs font-medium text-danger disabled:opacity-50"
            >
              Reject
            </button>
          </div>
          {review.isError && <div className="text-xs text-danger">{(review.error as Error)?.message}</div>}
        </div>
      )}

      {suggestion.status === "APPROVED" && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border-soft pt-2">
          <div className="text-[11px] text-text-secondary">
            Approved by {suggestion.reviewed_by ?? "—"}
            {suggestion.review_reason ? `: "${suggestion.review_reason}"` : ""}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as RediscoveryOutreachChannel)}
              className="rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
            >
              <option value="SMS">SMS</option>
              <option value="EMAIL">EMAIL</option>
              <option value="WHATSAPP">WHATSAPP</option>
            </select>
            <input
              value={templateCode}
              onChange={(e) => setTemplateCode(e.target.value)}
              placeholder="Template code"
              className="rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
            />
            <button
              disabled={sendOutreach.isPending}
              onClick={() =>
                sendOutreach.mutate({ suggestion_ids: [suggestion.suggestion_id], channel, template_code: templateCode.trim() })
              }
              className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {sendOutreach.isPending ? "Sending…" : "Send Outreach"}
            </button>
          </div>
          {sendOutreach.data && sendOutreach.data.skipped.length > 0 && (
            <div className="text-xs text-danger">{sendOutreach.data.skipped[0].reason}</div>
          )}
          {sendOutreach.data && sendOutreach.data.sent.length > 0 && <div className="text-xs text-success">Outreach sent.</div>}
        </div>
      )}

      {suggestion.status === "REJECTED" && (
        <div className="mt-3 border-t border-border-soft pt-2 text-[11px] text-text-secondary">
          Rejected by {suggestion.reviewed_by ?? "—"}
          {suggestion.review_reason ? `: "${suggestion.review_reason}"` : ""}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Outreach history
// ---------------------------------------------------------------------

function OutreachHistory({ targetCircularId }: { targetCircularId: string | null }) {
  const { data, isLoading, isError } = useRediscoveryOutreachHistory(
    targetCircularId ? { target_circular_id: targetCircularId } : {}
  );

  if (isLoading) return <EmptyState message="Loading outreach history…" />;
  if (isError) return <EmptyState message="Could not reach the rediscovery API." tone="danger" />;
  if (!data || data.outreach.length === 0) {
    return <EmptyState message="No outreach sent yet. Approve a suggestion above and send it to see history here." />;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-surface">
      <table className="w-full text-left text-xs">
        <thead className="bg-background">
          <tr className="text-text-secondary">
            <th className="px-3 py-2">Candidate</th>
            <th className="px-3 py-2">Circular</th>
            <th className="px-3 py-2">Channel</th>
            <th className="px-3 py-2">Template</th>
            <th className="px-3 py-2">Sent At</th>
            <th className="px-3 py-2">Response</th>
          </tr>
        </thead>
        <tbody>
          {data.outreach.map((o) => (
            <tr key={o.outreach_id} className="border-t border-border-soft">
              <td className="px-3 py-2 text-text-primary">{o.candidate_id}</td>
              <td className="px-3 py-2 text-text-secondary">{o.target_circular_id}</td>
              <td className="px-3 py-2 text-text-secondary">{o.channel}</td>
              <td className="px-3 py-2 text-text-secondary">{o.template_code}</td>
              <td className="px-3 py-2 text-text-secondary">{new Date(o.sent_at).toLocaleString()}</td>
              <td className="px-3 py-2 text-text-secondary">{o.response_status.replace("_", " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------

export function RediscoveryPanel() {
  const [activeCircularId, setActiveCircularId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RediscoverySuggestionStatus | "">("");
  const { data, isLoading, isError } = useRediscoverySuggestions({
    target_circular_id: activeCircularId ?? undefined,
    status: statusFilter || undefined,
  });

  if (!getToken()) return <EmptyState message="Connect with a dev token to use candidate rediscovery." />;

  return (
    <div className="flex flex-col gap-4">
      <ConsentLookup />
      <RunMatching onRun={setActiveCircularId} />

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-text-primary">
            Suggestions{activeCircularId ? ` for ${activeCircularId}` : ""}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={activeCircularId ?? ""}
              onChange={(e) => setActiveCircularId(e.target.value || null)}
              placeholder="Filter by circular ID"
              className="rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as RediscoverySuggestionStatus | "")}
              className="rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
            >
              <option value="">All statuses</option>
              <option value="PENDING_REVIEW">Pending Review</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
        </div>

        {isLoading && <EmptyState message="Loading suggestions…" />}
        {isError && <EmptyState message="Could not reach the rediscovery API." tone="danger" />}
        {data && data.suggestions.length === 0 && (
          <EmptyState message="No suggestions yet. Run matching above against a target circular and persona to populate this list." />
        )}
        {data && data.suggestions.length > 0 && (
          <div className="flex flex-col gap-3">
            {data.suggestions.map((s) => (
              <SuggestionRow key={s.suggestion_id} suggestion={s} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold text-text-primary">Sent Outreach History</div>
        <OutreachHistory targetCircularId={activeCircularId} />
      </div>
    </div>
  );
}
