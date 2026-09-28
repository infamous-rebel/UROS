import { useState } from "react";
import { useOnboardingTemplates, useEmployeeChecklist, useUpdateAssignment } from "../api/hooks_hr";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";

export function OnboardingPanel() {
  const { data: templates, isLoading, isError } = useOnboardingTemplates();
  const [employeeId, setEmployeeId] = useState("");
  const [lookupId, setLookupId] = useState<string | null>(null);
  const checklist = useEmployeeChecklist(lookupId);
  const updateAssignment = useUpdateAssignment();

  if (!getToken()) return <EmptyState message="Connect with a dev token to view onboarding." />;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase text-text-secondary">Templates</h3>
        {isLoading ? (
          <EmptyState message="Loading templates…" />
        ) : isError ? (
          <EmptyState message="Could not reach the onboarding API." tone="danger" />
        ) : !templates || templates.templates.length === 0 ? (
          <EmptyState message="No onboarding templates configured yet." />
        ) : (
          <ul className="space-y-1 text-sm">
            {templates.templates.map((t) => (
              <li key={t.template_id} className="rounded border border-border-soft p-2">
                <span className="font-medium text-text-primary">{t.name}</span>{" "}
                <span className="text-xs text-text-secondary">({t.checklist_items.length} steps)</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase text-text-secondary">Employee Checklist</h3>
        <div className="mb-2 flex gap-2">
          <input
            placeholder="Employee ID"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="flex-1 rounded border border-border-soft bg-background px-2 py-1 text-xs"
          />
          <button
            onClick={() => setLookupId(employeeId || null)}
            className="rounded bg-agent px-3 py-1 text-xs font-medium text-white"
          >
            Load
          </button>
        </div>

        {!lookupId ? (
          <EmptyState message="Enter an employee ID to view their onboarding checklist." />
        ) : checklist.isLoading ? (
          <EmptyState message="Loading checklist…" />
        ) : checklist.isError ? (
          <EmptyState message="Could not load checklist for this employee." tone="danger" />
        ) : !checklist.data || checklist.data.assignments.length === 0 ? (
          <EmptyState message="No checklist items assigned to this employee yet." />
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
                      Confirm complete
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
