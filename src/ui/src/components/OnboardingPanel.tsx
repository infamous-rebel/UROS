import { useState } from "react";
import { useOnboardingTemplates, useEmployeeChecklist, useUpdateAssignment } from "../api/hooks_hr";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";
import { useI18n } from "../i18n";

export function OnboardingPanel() {
  const { data: templates, isLoading, isError } = useOnboardingTemplates();
  const [employeeId, setEmployeeId] = useState("");
  const [lookupId, setLookupId] = useState<string | null>(null);
  const checklist = useEmployeeChecklist(lookupId);
  const updateAssignment = useUpdateAssignment();
  const { t } = useI18n();

  if (!getToken()) return <EmptyState message={t("onboarding.connectToken")} />;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase text-text-secondary">{t("onboarding.templates")}</h3>
        {isLoading ? (
          <EmptyState message={t("onboarding.loadingTemplates")} />
        ) : isError ? (
          <EmptyState message={t("onboarding.apiError")} tone="danger" />
        ) : !templates || templates.templates.length === 0 ? (
          <EmptyState message={t("onboarding.none")} />
        ) : (
          <ul className="space-y-1 text-sm">
            {templates.templates.map((t) => (
              <li key={t.template_id} className="rounded border border-border-soft p-2">
                <span className="font-medium text-text-primary">{t.name}</span>{" "}
                <span className="text-xs text-text-secondary">{t("onboarding.steps", { count: t.checklist_items.length })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase text-text-secondary">{t("onboarding.checklist")}</h3>
        <div className="mb-2 flex gap-2">
          <input
            placeholder={t("onboarding.employeeIdPlaceholder")}
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="flex-1 rounded border border-border-soft bg-background px-2 py-1 text-xs"
          />
          <button
            onClick={() => setLookupId(employeeId || null)}
            className="rounded bg-agent px-3 py-1 text-xs font-medium text-white"
          >
            {t("onboarding.load")}
          </button>
        </div>

        {!lookupId ? (
          <EmptyState message={t("onboarding.enterId")} />
        ) : checklist.isLoading ? (
          <EmptyState message={t("onboarding.loadingChecklist")} />
        ) : checklist.isError ? (
          <EmptyState message={t("onboarding.checklistError")} tone="danger" />
        ) : !checklist.data || checklist.data.assignments.length === 0 ? (
          <EmptyState message={t("onboarding.noneAssigned")} />
        ) : (
          <ul className="space-y-1 text-sm">
            {checklist.data.assignments.map((a) => (
              <li key={a.assignment_id} className="flex items-center justify-between rounded border border-border-soft p-2">
                <span className="text-text-primary">{a.label}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs ${a.status === "COMPLETED" ? "text-success" : a.status === "OVERDUE" ? "text-danger" : "text-text-secondary"}`}>
                    {a.status}
                  </span>
                  {a.status !== "COMPLETED" && (
                    <button
                      onClick={() => updateAssignment.mutate({ id: a.assignment_id, status: "COMPLETED" })}
                      className="rounded bg-human px-2 py-0.5 text-xs font-medium text-white"
                    >
                      {t("onboarding.confirmComplete")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
