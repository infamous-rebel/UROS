import { useKpiScores, useApproveKpiScore } from "../api/hooks_hr";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";
import { useI18n } from "../i18n";

export function KpiPanel() {
  const { data, isLoading, isError } = useKpiScores();
  const approve = useApproveKpiScore();
  const { t } = useI18n();

  if (!getToken()) return <EmptyState message={t("kpi.connectToken")} />;
  if (isLoading) return <EmptyState message={t("kpi.loading")} />;
  if (isError) return <EmptyState message={t("kpi.apiError")} tone="danger" />;
  if (!data || data.kpi_scores.length === 0) return <EmptyState message={t("kpi.none")} />;

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-border-soft text-xs uppercase text-text-secondary">
          <th className="py-2 pr-3">{t("kpi.col.period")}</th>
          <th className="py-2 pr-3">{t("kpi.col.score")}</th>
          <th className="py-2 pr-3">{t("kpi.col.band")}</th>
          <th className="py-2 pr-3">{t("kpi.col.status")}</th>
          <th className="py-2">{t("kpi.col.action")}</th>
        </tr>
      </thead>
      <tbody>
        {data.kpi_scores.map((s) => (
          <tr key={s.score_id} className="border-b border-border-soft last:border-0">
            <td className="py-2 pr-3 text-text-primary">{s.period}</td>
            <td className="py-2 pr-3 text-agent">{s.approved_score ?? s.calculated_score}</td>
            <td className="py-2 pr-3 text-text-secondary">{s.band ?? "—"}</td>
            <td className="py-2 pr-3 text-xs text-text-secondary">{s.status}</td>
            <td className="py-2">
              {s.status === "CALCULATED" && (
                <button
                  onClick={() => approve.mutate({ id: s.score_id, decision: "APPROVE" })}
                  className="rounded bg-human px-2 py-1 text-xs font-medium text-white"
                >
                  {t("kpi.approve")}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
