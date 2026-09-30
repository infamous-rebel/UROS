import { useMemo, useState } from "react";
import {
  useDimensionScores,
  useResolveDimensionScore,
  useRunDimensionScoring,
  DimensionBreakdownEntry,
} from "../hooks/hooks_dimensions";
import { getToken } from "../api/client";
import { useI18n } from "../i18n";
import { EmptyState } from "./EmptyState";
import { getIcon } from "./navigation/iconRegistry";
import { Icon } from "./navigation/Icon";
import { ReasonCode } from "./ReasonCode";

const DECISION_COLOR: Record<string, string> = {
  AUTO_PASS: "text-success",
  NEEDS_REVIEW: "text-attention",
  AUTO_FAIL: "text-danger",
};

const STATUS_COLOR: Record<string, string> = {
  CALCULATED: "text-attention",
  APPROVED: "text-success",
  REJECTED: "text-danger",
  OVERRIDDEN: "text-human",
};

function ScoreBar({ label, value, tone = "agent" }: { label: string; value: number; tone?: "agent" | "danger" }) {
  const barColor = tone === "danger" ? "bg-danger" : "bg-agent";
  return (
    <div className="flex items-center gap-2">
      <span className="w-40 flex-shrink-0 truncate text-xs text-text-secondary">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-border-soft">
        <div className={`h-full ${barColor}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <span className="w-10 flex-shrink-0 text-right text-xs font-medium text-text-primary">{value}</span>
    </div>
  );
}

function DimensionRow({ dim }: { dim: DimensionBreakdownEntry }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border-soft bg-surface">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <div className="flex-1">
          <ScoreBar label={dim.dimension_name} value={dim.raw_score} tone={dim.knockout_failed ? "danger" : "agent"} />
        </div>
        <span className="flex-shrink-0 text-[11px] text-text-secondary">
          weight {dim.weight} → {dim.weighted_score}
        </span>
        {dim.is_knockout && (
          <span
            className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              dim.knockout_failed ? "bg-danger text-white" : "bg-border-soft text-text-secondary"
            }`}
          >
            {t("dimension.knockoutLabel")}
          </span>
        )}
        <span className="flex-shrink-0 text-xs text-text-secondary"><Icon icon={getIcon(open ? "ChevronUp" : "ChevronDown")} size={14} tone="neutral" /></span>
      </button>

      {open && (
        <div className="border-t border-border-soft px-3 py-2">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-text-secondary">
                <th className="py-1 pr-2">{t("dimension.subcriterion")}</th>
                <th className="py-1 pr-2">{t("dimension.rule")}</th>
                <th className="py-1 pr-2">{t("dimension.extracted")}</th>
                <th className="py-1 pr-2">{t("dimension.result")}</th>
                <th className="py-1">{t("dimension.points")}</th>
              </tr>
            </thead>
            <tbody>
              {dim.subcriteria.map((s) => (
                <tr key={s.subcriterion_id} className="border-t border-border-soft">
                  <td className="py-1 pr-2 text-text-primary">{s.label}</td>
                  <td className="py-1 pr-2 font-mono text-text-secondary">
                    {s.operator} {JSON.stringify(s.threshold_value)}
                  </td>
                  <td className="py-1 pr-2 text-text-secondary">
                    {s.extracted_value === null || s.extracted_value === undefined
                      ? "—"
                      : JSON.stringify(s.extracted_value)}
                  </td>
                  <td className="py-1 pr-2">
                    {s.flagged ? (
                      <span className="text-attention">{s.flag_reason}</span>
                    ) : s.matched ? (
                      <span className="text-success">{t("dimension.match")}</span>
                    ) : (
                      <ReasonCode code={s.reason_code} size="sm" />
                    )}
                  </td>
                  <td className="py-1 text-text-primary">{s.points_earned}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DimensionScorecard() {
  const { t } = useI18n();
  const [candidateId, setCandidateId] = useState("");
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [showOverrideFor, setShowOverrideFor] = useState<string | null>(null);

  const { data, isLoading, isError } = useDimensionScores(activeCandidateId);
  const resolve = useResolveDimensionScore(activeCandidateId);
  const run = useRunDimensionScoring(activeCandidateId);

  const latest = useMemo(() => data?.dimension_scores?.[0] ?? null, [data]);

  if (!getToken()) return <EmptyState message={t("dimension.tokenRequired")} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <input
          value={candidateId}
          onChange={(e) => setCandidateId(e.target.value)}
          placeholder={t("dimension.candidatePlaceholder")}
          className="flex-1 rounded-md border border-border-soft bg-surface px-3 py-1.5 text-sm text-text-primary"
        />
        <button
          onClick={() => setActiveCandidateId(candidateId.trim() || null)}
          className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white"
        >
          {t("dimension.load")}
        </button>
        <button
          disabled={!activeCandidateId || run.isPending}
          onClick={() => run.mutate({})}
          className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {run.isPending ? t("dimension.scoring") : t("dimension.runScoring")}
        </button>
      </div>

      {!activeCandidateId && <EmptyState message={t("dimension.emptyPrompt")} />}
      {activeCandidateId && isLoading && <EmptyState message={t("dimension.loading")} />}
      {activeCandidateId && isError && <EmptyState message={t("dimension.apiError")} tone="danger" />}
      {activeCandidateId && !isLoading && !isError && !latest && (
        <EmptyState message={t("dimension.noScore")} />
      )}

      {latest && (
        <div className="flex flex-col gap-4">
          {/* Overall fit score — the headline number, always visible, never a lone chart */}
          <div className="flex items-center justify-between rounded-lg border border-border-soft bg-surface p-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-text-secondary">{t("dimension.overallFit")}</div>
              <div className="text-3xl font-semibold text-agent">{latest.overall_fit_score}</div>
            </div>
            <div className="text-right">
              <div className={`text-sm font-medium ${DECISION_COLOR[latest.recommended_decision]}`}>
                {latest.recommended_decision.replace("_", " ")}
              </div>
              {latest.knockout_triggered && (
                <div className="mt-1 max-w-xs text-xs text-danger">{latest.knockout_reason}</div>
              )}
              <div className={`mt-1 text-xs font-medium ${STATUS_COLOR[latest.status]}`}>{latest.status}</div>
            </div>
          </div>

          {/* Dimension bar list with drill-down evidence per dimension */}
          <div className="flex flex-col gap-2">
            {latest.dimension_breakdown
              .slice()
              .sort((a, b) => a.sequence - b.sequence)
              .map((dim) => (
                <DimensionRow key={dim.dimension_config_id} dim={dim} />
              ))}
          </div>

          {/* Human-in-the-loop decision — the agent only ever suggests */}
          <div className="rounded-lg border border-border-soft bg-surface p-3">
            <div className="mb-2 text-xs font-medium text-text-secondary">{t("dimension.humanDecision")}</div>
            {latest.status !== "CALCULATED" ? (
              <div className="text-xs text-text-secondary">
                {t("dimension.alreadyResolved")} <span className={STATUS_COLOR[latest.status]}>{latest.status}</span>
                {latest.human_reviewer ? ` by ${latest.human_reviewer}` : ""}
                {latest.override_reason ? ` — “${latest.override_reason}”` : ""}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      resolve.mutate({ evaluationId: latest.evaluation_id, decision: "APPROVE" })
                    }
                    className="rounded bg-human px-3 py-1.5 text-xs font-medium text-white"
                  >
                    {t("dimension.approve")}
                  </button>
                  <button
                    onClick={() =>
                      resolve.mutate({ evaluationId: latest.evaluation_id, decision: "REJECT" })
                    }
                    className="rounded border border-danger px-3 py-1.5 text-xs font-medium text-danger"
                  >
                    {t("dimension.reject")}
                  </button>
                  <button
                    onClick={() => setShowOverrideFor(latest.evaluation_id)}
                    className="rounded border border-attention px-3 py-1.5 text-xs font-medium text-attention"
                  >
                    {t("dimension.override")}
                  </button>
                </div>
                {showOverrideFor === latest.evaluation_id && (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      placeholder={t("dimension.overrideReason")}
                      className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
                      rows={2}
                    />
                    <div className="flex gap-2">
                      <button
                        disabled={!overrideReason.trim()}
                        onClick={() => {
                          resolve.mutate({
                            evaluationId: latest.evaluation_id,
                            decision: "OVERRIDE",
                            override_reason: overrideReason.trim(),
                          });
                          setShowOverrideFor(null);
                          setOverrideReason("");
                        }}
                        className="rounded bg-attention px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                      >
                        {t("dimension.confirmOverride")}
                      </button>
                      <button
                        onClick={() => {
                          setShowOverrideFor(null);
                          setOverrideReason("");
                        }}
                        className="rounded px-3 py-1.5 text-xs text-text-secondary"
                      >
                        {t("dimension.cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
