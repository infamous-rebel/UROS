import { useImprovementSuggestions, useUpdateSuggestion } from "../api/hooks_hr";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";
import { useI18n } from "../i18n";

export function ImprovementsPanel() {
  const { data, isLoading, isError } = useImprovementSuggestions();
  const update = useUpdateSuggestion();
  const { t } = useI18n();

  if (!getToken()) return <EmptyState message={t("improvements.connectToken")} />;
  if (isLoading) return <EmptyState message={t("improvements.loading")} />;
  if (isError) return <EmptyState message={t("improvements.apiError")} tone="danger" />;
  if (!data || data.suggestions.length === 0) return <EmptyState message={t("improvements.none")} tone="success" />;

  return (
    <ul className="space-y-2">
      {data.suggestions.map((s) => (
        <li key={s.suggestion_id} className="rounded-md border border-border-soft p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-attention">{s.gap_type}</span>
            <span className="text-text-secondary">{s.status} · {s.source}</span>
          </div>
          <p className="mt-1 text-sm text-text-primary">{s.suggestion}</p>
          <div className="mt-2 flex gap-2">
            {s.status === "SUGGESTED" && (
              <button
                onClick={() => update.mutate({ id: s.suggestion_id, status: "MANAGER_APPROVED" })}
                className="rounded bg-human px-2 py-1 text-xs font-medium text-white"
              >
                {t("kpi.approve")}
              </button>
            )}
            {s.status === "MANAGER_APPROVED" && (
              <button
                onClick={() => {
                  const assignee = window.prompt(t("improvements.assignPrompt"));
                  if (assignee) update.mutate({ id: s.suggestion_id, status: "HR_ASSIGNED", assigned_to: assignee });
                }}
                className="rounded bg-agent px-2 py-1 text-xs font-medium text-white"
              >
                {t("improvements.hrAssign")}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
