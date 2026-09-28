import { useTaskLogs, useUpdateTaskStatus, useApproveTaskClosure } from "../api/hooks_hr";
import { getToken } from "../api/client";
import { EmptyState } from "./EmptyState";

const STATUS_COLOR: Record<string, string> = {
  TODO: "text-text-secondary",
  IN_PROGRESS: "text-agent",
  DONE: "text-success",
  BLOCKED: "text-danger",
};

export function TaskLogsPanel() {
  const { data, isLoading, isError } = useTaskLogs();
  const updateStatus = useUpdateTaskStatus();
  const approveClosure = useApproveTaskClosure();

  if (!getToken()) return <EmptyState message="Connect with a dev token to view tasks." />;
  if (isLoading) return <EmptyState message="Loading tasks…" />;
  if (isError) return <EmptyState message="Could not reach the task log API." tone="danger" />;
  if (!data || data.tasks.length === 0) return <EmptyState message="No tasks logged yet." tone="success" />;

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-border-soft text-xs uppercase text-text-secondary">
          <th className="py-2 pr-3">Title</th>
          <th className="py-2 pr-3">Priority</th>
          <th className="py-2 pr-3">Status</th>
          <th className="py-2 pr-3">Due</th>
          <th className="py-2">Actions</th>
        </tr>
      </thead>
      <tbody>
        {data.tasks.map((t) => (
          <tr key={t.task_id} className="border-b border-border-soft last:border-0">
            <td className="py-2 pr-3 text-text-primary">{t.title}</td>
            <td className="py-2 pr-3 text-text-secondary">{t.priority}</td>
            <td className={`py-2 pr-3 font-medium ${STATUS_COLOR[t.status] ?? ""}`}>{t.status}</td>
            <td className="py-2 pr-3 text-text-secondary">{t.due_date ? new Date(t.due_date).toLocaleDateString() : "—"}</td>
            <td className="py-2">
              {t.status !== "DONE" ? (
                <select
                  value={t.status}
                  onChange={(e) => updateStatus.mutate({ id: t.task_id, status: e.target.value })}
                  className="rounded border border-border-soft bg-background px-2 py-1 text-xs"
                >
                  {["TODO", "IN_PROGRESS", "DONE", "BLOCKED"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              ) : !t.closure_approved_by ? (
                <button
                  onClick={() => approveClosure.mutate(t.task_id)}
                  className="rounded bg-human px-2 py-1 text-xs font-medium text-white"
                >
                  Approve closure
                </button>
              ) : (
                <span className="text-xs text-success">Closed</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
