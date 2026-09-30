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
import { useI18n } from "../i18n";
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
  const { t } = useI18n();
  const [candidateIdInput, setCandidateIdInput] = useState("");
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  const { data, isLoading, isError } = useRediscoveryConsent(lookedUp);
  const setConsent = useSetRediscoveryConsent();

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">{t("rediscovery.candidateConsent")}</div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={candidateIdInput}
          onChange={(e) => setCandidateIdInput(e.target.value)}
          placeholder={t("rediscovery.candidateId")}
          className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <button
          onClick={() => setLookedUp(candidateIdInput.trim() || null)}
          className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white"
        >
          {t("rediscovery.checkStatus")}
        </button>
      </div>

      {lookedUp && (
        <div className="mt-3 border-t border-border-soft pt-2">
          {isLoading && <EmptyState message={t("rediscovery.loadingConsent")} />}
          {isError && <EmptyState message={t("rediscovery.apiError")} tone="danger" />}
          {data && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-text-primary">{lookedUp}:</span>
              <ConsentBadge status={data.status} />
              {data.consent?.updated_at && (
                <span className="text-[11px] text-text-secondary">
                  {t("rediscovery.lastUpdated")} {new Date(data.consent.updated_at).toLocaleString()}
                </span>
              )}
              <div className="flex gap-2">
                <button
                  disabled={setConsent.isPending}
                  onClick={() => setConsent.mutate({ candidate_id: lookedUp, opted_in: true })}
                  className="rounded bg-success px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  {t("rediscovery.recordOptIn")}
                </button>
                <button
                  disabled={setConsent.isPending}
                  onClick={() => setConsent.mutate({ candidate_id: lookedUp, opted_in: false })}
                  className="rounded border border-danger px-2.5 py-1 text-[11px] font-medium text-danger disabled:opacity-50"
                >
                  {t("rediscovery.recordOptOut")}
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
  const { t } = useI18n();
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
      <div className="mb-2 text-xs font-semibold text-text-primary">{t("rediscovery.runMatching")}</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <input
          value={targetCircularId}
          onChange={(e) => setTargetCircularId(e.target.value)}
          placeholder={t("rediscovery.targetCircular")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <input
          value={targetPosition}
          onChange={(e) => setTargetPosition(e.target.value)}
          placeholder={t("rediscovery.targetPosition")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <input
          value={personaId}
          onChange={(e) => setPersonaId(e.target.value)}
          placeholder={t("rediscovery.personaId")}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <label className="flex items-center gap-2 text-[11px] text-text-secondary">
          {t("rediscovery.minFitScore")}
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
          {t("rediscovery.cooldown")}
          <input
            type="number"
            min={0}
            value={minDaysSinceDecision}
            onChange={(e) => setMinDaysSinceDecision(Number(e.target.value))}
            className="w-20 rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
          />
        </label>
        <label className="flex items-center gap-2 text-[11px] text-text-secondary">
          {t("rediscovery.maxCandidates")}
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
          {t("rediscovery.requireOptIn")}
        </label>
      </div>
      <div className="mt-2">
        <button
          disabled={!canRun || run.isPending}
          onClick={trigger}
          className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {run.isPending ? t("rediscovery.running") : t("rediscovery.runMatch")}
        </button>
      </div>
      {run.isError && <div className="mt-2 text-xs text-danger">{(run.error as Error)?.message ?? t("rediscovery.runFailed")}</div>}
      {run.data && (
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border-soft pt-2 text-[11px] sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={t("rediscovery.considered")} value={run.data.candidates_considered} />
          <Stat label={t("rediscovery.suggested")} value={run.data.suggestions_created.length} tone="success" />
          <Stat label={t("rediscovery.belowThreshold")} value={run.data.candidates_below_threshold} />
          <Stat label={t("rediscovery.exclConsent")} value={run.data.candidates_excluded_consent} />
          <Stat label={t("rediscovery.exclFraud")} value={run.data.candidates_excluded_fraud} tone="danger" />
          <Stat label={t("rediscovery.exclRecent")} value={run.data.candidates_excluded_recent} />
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
  const { t } = useI18n();
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
        <summary className="cursor-pointer text-xs text-agent underline">{t("rediscovery.whyEvidence")}</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-2 text-[11px] text-text-secondary">
          {JSON.stringify(suggestion.evidence, null, 2)}
        </pre>
      </details>

      {suggestion.status === "PENDING_REVIEW" && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border-soft pt-2">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("rediscovery.reasonPlaceholder")}
            rows={2}
            className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
          />
          {pendingAction && !reason.trim() && (
            <div className="text-xs text-danger">{t("rediscovery.reasonRequired", { action: pendingAction === "APPROVE" ? t("rediscovery.approving") : t("rediscovery.rejecting") })}</div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              disabled={review.isPending}
              onClick={() => submitReview("APPROVE")}
              className="rounded bg-success px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {t("rediscovery.approve")}
            </button>
            <button
              disabled={review.isPending}
              onClick={() => submitReview("REJECT")}
              className="rounded border border-danger px-3 py-1.5 text-xs font-medium text-danger disabled:opacity-50"
            >
              {t("rediscovery.reject")}
            </button>
          </div>
          {review.isError && <div className="text-xs text-danger">{(review.error as Error)?.message}</div>}
        </div>
      )}

      {suggestion.status === "APPROVED" && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border-soft pt-2">
          <div className="text-[11px] text-text-secondary">
            {t("rediscovery.approvedBy")} {suggestion.reviewed_by ?? "—"}
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
              placeholder={t("rediscovery.templateCode")}
              className="rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
            />
            <button
              disabled={sendOutreach.isPending}
              onClick={() =>
                sendOutreach.mutate({ suggestion_ids: [suggestion.suggestion_id], channel, template_code: templateCode.trim() })
              }
              className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {sendOutreach.isPending ? t("rediscovery.sending") : t("rediscovery.sendOutreach")}
            </button>
          </div>
          {sendOutreach.data && sendOutreach.data.skipped.length > 0 && (
            <div className="text-xs text-danger">{sendOutreach.data.skipped[0].reason}</div>
          )}
          {sendOutreach.data && sendOutreach.data.sent.length > 0 && <div className="text-xs text-success">{t("rediscovery.outreachSent")}</div>}
        </div>
      )}

      {suggestion.status === "REJECTED" && (
        <div className="mt-3 border-t border-border-soft pt-2 text-[11px] text-text-secondary">
          {t("rediscovery.rejectedBy")} {suggestion.reviewed_by ?? "—"}
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
  const { t } = useI18n();
  const { data, isLoading, isError } = useRediscoveryOutreachHistory(
    targetCircularId ? { target_circular_id: targetCircularId } : {}
  );

  if (isLoading) return <EmptyState message={t("rediscovery.loadingHistory")} />;
  if (isError) return <EmptyState message={t("rediscovery.apiError")} tone="danger" />;
  if (!data || data.outreach.length === 0) {
    return <EmptyState message={t("rediscovery.noHistory")} />;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-surface">
      <table className="w-full text-left text-xs">
        <thead className="bg-background">
          <tr className="text-text-secondary">
            <th className="px-3 py-2">{t("rediscovery.candidate")}</th>
            <th className="px-3 py-2">{t("rediscovery.circular")}</th>
            <th className="px-3 py-2">{t("rediscovery.channel")}</th>
            <th className="px-3 py-2">{t("rediscovery.template")}</th>
            <th className="px-3 py-2">{t("rediscovery.sentAt")}</th>
            <th className="px-3 py-2">{t("rediscovery.response")}</th>
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
  const { t } = useI18n();
  const [activeCircularId, setActiveCircularId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RediscoverySuggestionStatus | "">("");
  const { data, isLoading, isError } = useRediscoverySuggestions({
    target_circular_id: activeCircularId ?? undefined,
    status: statusFilter || undefined,
  });

  if (!getToken()) return <EmptyState message={t("rediscovery.tokenRequired")} />;

  return (
    <div className="flex flex-col gap-4">
      <ConsentLookup />
      <RunMatching onRun={setActiveCircularId} />

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-text-primary">
            {t("rediscovery.suggestions")}{activeCircularId ? ` ${t("rediscovery.forCircular", { circularId: activeCircularId })}` : ""}
          </div>
          <div className="flex items-center gap-2">
            <input
              value={activeCircularId ?? ""}
              onChange={(e) => setActiveCircularId(e.target.value || null)}
              placeholder={t("rediscovery.filterCircular")}
              className="rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as RediscoverySuggestionStatus | "")}
              className="rounded-md border border-border-soft bg-background px-2 py-1 text-xs text-text-primary"
            >
              <option value="">{t("rediscovery.allStatuses")}</option>
              <option value="PENDING_REVIEW">{t("rediscovery.pendingReview")}</option>
              <option value="APPROVED">{t("rediscovery.approve")}</option>
              <option value="REJECTED">{t("rediscovery.reject")}</option>
            </select>
          </div>
        </div>

        {isLoading && <EmptyState message={t("rediscovery.loadingSuggestions")} />}
        {isError && <EmptyState message={t("rediscovery.apiError")} tone="danger" />}
        {data && data.suggestions.length === 0 && (
          <EmptyState message={t("rediscovery.noSuggestions")} />
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
        <div className="mb-2 text-xs font-semibold text-text-primary">{t("rediscovery.outreachHistory")}</div>
        <OutreachHistory targetCircularId={activeCircularId} />
      </div>
    </div>
  );
}
