import { useState } from "react";
import {
  useConfigureOffboardingTemplate,
  useStartOffboardingCase,
  useOffboardingCase,
  useUpdateOffboardingStep,
  OffboardingChecklistItem,
  OffboardingStepRow,
  OffboardingStepStatus,
  OffboardingStepAction,
} from "../hooks/hooks_offboarding";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";

const STATUS_BADGE: Record<OffboardingStepStatus, string> = {
  PENDING: "bg-border-soft text-text-secondary",
  IN_PROGRESS: "bg-agent text-white",
  COMPLETED: "bg-human text-white",
  APPROVED: "bg-success text-white",
  REJECTED: "bg-danger text-white",
  OVERDUE: "bg-attention text-white",
};

function StatusBadge({ status }: { status: OffboardingStepStatus }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[status]}`}>{status.replace("_", " ")}</span>;
}

function emptyChecklistItem(): OffboardingChecklistItem {
  return { item_code: "", title: "", category: "", default_due_days_from_exit: 0 };
}

/** Template configuration form: builds/edits an offboarding checklist for a role. No blank forms — always starts with one row. */
function TemplateConfigForm() {
  const configure = useConfigureOffboardingTemplate();
  const [role, setRole] = useState("");
  const [items, setItems] = useState<OffboardingChecklistItem[]>([emptyChecklistItem()]);

  const updateItem = (idx: number, patch: Partial<OffboardingChecklistItem>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };
  const addItem = () => setItems((prev) => [...prev, emptyChecklistItem()]);
  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));

  const submit = () => {
    if (!role.trim()) return;
    const checklist = items
      .filter((it) => it.item_code.trim() && it.title.trim())
      .map((it) => ({
        item_code: it.item_code.trim(),
        title: it.title.trim(),
        category: it.category?.trim() || undefined,
        default_due_days_from_exit: it.default_due_days_from_exit,
      }));
    if (checklist.length === 0) return;
    configure.mutate({ role: role.trim(), checklist });
  };

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">Configure Offboarding Template</div>
      <input
        value={role}
        onChange={(e) => setRole(e.target.value)}
        placeholder="Role (e.g. Branch Officer)"
        className="mb-2 w-full rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
      />
      <div className="flex flex-col gap-2">
        {items.map((it, idx) => (
          <div key={idx} className="flex flex-wrap items-center gap-2 rounded border border-border-soft p-2">
            <input
              value={it.item_code}
              onChange={(e) => updateItem(idx, { item_code: e.target.value })}
              placeholder="item_code"
              className="w-28 rounded border border-border-soft bg-background px-2 py-1 text-xs"
            />
            <input
              value={it.title}
              onChange={(e) => updateItem(idx, { title: e.target.value })}
              placeholder="Step title"
              className="min-w-[10rem] flex-1 rounded border border-border-soft bg-background px-2 py-1 text-xs"
            />
            <input
              value={it.category ?? ""}
              onChange={(e) => updateItem(idx, { category: e.target.value })}
              placeholder="Category"
              className="w-28 rounded border border-border-soft bg-background px-2 py-1 text-xs"
            />
            <input
              type="number"
              value={it.default_due_days_from_exit ?? 0}
              onChange={(e) => updateItem(idx, { default_due_days_from_exit: Number(e.target.value) })}
              title="Days relative to exit date (negative = before exit)"
              className="w-20 rounded border border-border-soft bg-background px-2 py-1 text-xs"
            />
            <button onClick={() => removeItem(idx)} className="text-xs text-danger">
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button onClick={addItem} className="rounded border border-border-soft px-3 py-1.5 text-xs font-medium text-text-primary">
          + Add step
        </button>
        <button
          disabled={configure.isPending}
          onClick={submit}
          className="rounded-md bg-agent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {configure.isPending ? "Saving…" : "Save Template"}
        </button>
      </div>
      {configure.isError && <div className="mt-2 text-xs text-danger">{(configure.error as Error)?.message ?? "Save failed."}</div>}
      {configure.isSuccess && (
        <div className="mt-2 text-xs text-success">
          Template saved: <span className="font-mono">{configure.data?.template.template_id}</span>
        </div>
      )}
    </div>
  );
}

/** Starts a new offboarding case for an employee from a saved template. */
function StartCaseForm() {
  const start = useStartOffboardingCase();
  const [employeeId, setEmployeeId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [exitDate, setExitDate] = useState("");

  const submit = () => {
    if (!employeeId.trim() || !templateId.trim() || !exitDate.trim()) return;
    start.mutate({ employee_id: employeeId.trim(), template_id: templateId.trim(), exit_date: exitDate.trim() });
  };

  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="mb-2 text-xs font-semibold text-text-primary">Start Offboarding Case</div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          placeholder="Employee ID"
          className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <input
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          placeholder="Template ID"
          className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <input
          type="date"
          value={exitDate}
          onChange={(e) => setExitDate(e.target.value)}
          className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
        />
        <button
          disabled={start.isPending}
          onClick={submit}
          className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {start.isPending ? "Starting…" : "Start Case"}
        </button>
      </div>
      {start.isError && <div className="mt-2 text-xs text-danger">{(start.error as Error)?.message ?? "Could not start case."}</div>}
      {start.isSuccess && (
        <div className="mt-2 text-xs text-success">
          Case started: <span className="font-mono">{start.data?.case.case_id}</span> ({start.data?.steps.length} steps)
        </div>
      )}
    </div>
  );
}

function StepActionControls({ step, caseId }: { step: OffboardingStepRow; caseId: string }) {
  const update = useUpdateOffboardingStep(caseId);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<OffboardingStepAction | null>(null);

  const submit = (action: OffboardingStepAction) => {
    if (!reason.trim()) {
      setPending(action);
      return;
    }
    update.mutate({ stepId: step.step_id, action, reason: reason.trim() });
  };

  const canComplete = ["PENDING", "IN_PROGRESS", "OVERDUE", "REJECTED"].includes(step.status);
  const canReview = step.status === "COMPLETED";

  if (!canComplete && !canReview) {
    return step.approval_reason ? (
      <div className="mt-2 border-t border-border-soft pt-2 text-[11px] text-text-secondary">
        {step.status === "APPROVED" ? "Approved" : "Reviewed"}: {step.approval_reason}
      </div>
    ) : null;
  }

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border-soft pt-2">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Mandatory reason for this action…"
        rows={2}
        className="rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs"
      />
      {pending && !reason.trim() && <div className="text-xs text-danger">A reason is required before {pending.toLowerCase()}.</div>}
      <div className="flex flex-wrap gap-2">
        {canComplete && (
          <button onClick={() => submit("COMPLETE")} className="rounded bg-agent px-3 py-1.5 text-xs font-medium text-white">
            Mark Complete
          </button>
        )}
        {canReview && (
          <>
            <button onClick={() => submit("APPROVE")} className="rounded bg-success px-3 py-1.5 text-xs font-medium text-white">
              Approve
            </button>
            <button onClick={() => submit("REJECT")} className="rounded border border-danger px-3 py-1.5 text-xs font-medium text-danger">
              Reject
            </button>
          </>
        )}
      </div>
      {update.isError && <div className="text-xs text-danger">{(update.error as Error)?.message ?? "Update failed."}</div>}
    </div>
  );
}

function StepRow({ step, caseId }: { step: OffboardingStepRow; caseId: string }) {
  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-text-primary">{step.title}</div>
          <div className="mt-1 flex items-center gap-2">
            <StatusBadge status={step.status} />
            {step.category && <span className="text-[11px] text-text-secondary">{step.category}</span>}
            {step.due_date && (
              <span className={`text-[11px] ${step.status === "OVERDUE" ? "text-danger" : "text-text-secondary"}`}>
                Due {new Date(step.due_date).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      </div>
      <StepActionControls step={step} caseId={caseId} />
    </div>
  );
}

export function OffboardingPanel() {
  const [caseIdInput, setCaseIdInput] = useState("");
  const [caseId, setCaseId] = useState<string | null>(null);
  const { data, isLoading, isError } = useOffboardingCase(caseId);

  if (!getToken()) return <EmptyState message="Connect with a dev token to manage offboarding." />;

  return (
    <div className="flex flex-col gap-4">
      <TemplateConfigForm />
      <StartCaseForm />

      <div className="rounded-lg border border-border-soft bg-surface p-3">
        <div className="mb-2 text-xs font-semibold text-text-primary">Look Up Offboarding Case</div>
        <div className="flex gap-2">
          <input
            value={caseIdInput}
            onChange={(e) => setCaseIdInput(e.target.value)}
            placeholder="Case ID"
            className="flex-1 rounded-md border border-border-soft bg-background px-2 py-1.5 text-xs text-text-primary"
          />
          <button
            onClick={() => setCaseId(caseIdInput.trim() || null)}
            className="rounded-md bg-human px-3 py-1.5 text-xs font-medium text-white"
          >
            View Case
          </button>
        </div>
      </div>

      {!caseId ? (
        <EmptyState message="Look up a case ID to view its offboarding steps." />
      ) : isLoading ? (
        <EmptyState message="Loading case…" />
      ) : isError ? (
        <EmptyState message="Could not load this offboarding case." tone="danger" />
      ) : !data ? (
        <EmptyState message="Offboarding case not found." tone="danger" />
      ) : (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold text-text-primary">
              Case {data.case.case_id} — exit date {data.case.exit_date}
            </div>
            <span
              className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                data.case.status === "COMPLETED" ? "bg-success text-white" : data.case.status === "CANCELLED" ? "bg-border-soft text-text-secondary" : "bg-agent text-white"
              }`}
            >
              {data.case.status}
            </span>
          </div>
          {data.steps.length === 0 ? (
            <EmptyState message="This case has no steps." tone="neutral" />
          ) : (
            <div className="flex flex-col gap-3">
              {data.steps.map((s) => (
                <StepRow key={s.step_id} step={s} caseId={data.case.case_id} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
