/**
 * Agent Health — the resilience view inside the audit sidebar.
 *
 * Reads the same `/health` payload the orchestrator probes, through the
 * existing `useHealth` poll (5s): no new endpoint, no second polling loop,
 * no new dependency. It belongs next to the Audit Stream rather than in its
 * own tab because the two answer one question — "what did the platform do,
 * and was any agent refusing or retrying work while it did it?"
 *
 * Attention-first: agents that are idle or healthy are counted in the
 * summary line and only listed on request. With 40+ registered agents,
 * rendering every "CLOSED / never invoked" row would be dead space that
 * hides the one open circuit an operator actually needs to see.
 */
import { useState } from "react";
import { useHealth } from "../api/hooks";
import type { AgentHealthEntry } from "../api/client";
import { EmptyState } from "./EmptyState";

/** An agent worth a row on its own: refusing work, degraded, or backed up. */
function needsAttention(agent: AgentHealthEntry): boolean {
  return agent.status === "unavailable" || agent.status === "degraded" || agent.queue_depth > 0 || agent.in_flight > 0;
}

/** unavailable first, then degraded, then merely busy — and stable within a tier. */
const SEVERITY: Record<AgentHealthEntry["status"], number> = { unavailable: 0, degraded: 1, healthy: 2, idle: 3 };

function bySeverity(a: AgentHealthEntry, b: AgentHealthEntry): number {
  const tier = SEVERITY[a.status] - SEVERITY[b.status];
  return tier !== 0 ? tier : a.agent_name.localeCompare(b.agent_name);
}

const CIRCUIT_TONE: Record<AgentHealthEntry["circuit_state"], string> = {
  CLOSED: "border-border-soft text-success",
  HALF_OPEN: "border-attention text-attention",
  OPEN: "border-danger text-danger",
};

function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString() : "—";
}

export function AgentHealth() {
  const { data, isLoading, isError } = useHealth();
  const [showAll, setShowAll] = useState(false);
  const report = data?.agent_health;

  const agents = report?.agents ?? [];
  const visible = showAll ? [...agents].sort(bySeverity) : agents.filter(needsAttention).sort(bySeverity);
  const hiddenCount = agents.length - visible.length;

  return (
    <section className="flex max-h-[46%] flex-shrink-0 flex-col rounded-lg border border-border-soft bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Agent Health</h2>
        {report && (
          <span className="text-right text-[11px] text-text-secondary">
            {report.totals.agents} agents · {report.totals.circuits_open} open · {report.totals.queued} queued
          </span>
        )}
      </div>

      {isLoading ? (
        <EmptyState message="Loading agent runtime status…" />
      ) : isError ? (
        <EmptyState message="Could not reach the /health endpoint." tone="danger" />
      ) : !report ? (
        <EmptyState message="This API build does not report per-agent health yet." />
      ) : agents.length === 0 ? (
        <EmptyState message="No agents registered in this process yet." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {!showAll && visible.length === 0 && (
            <p className="rounded-md border border-dashed border-border-soft px-3 py-2 text-xs text-success">
              All {report.totals.agents} agents healthy — no circuit open, no queue backlog.
            </p>
          )}

          {visible.length > 0 && (
            <ul className="min-h-0 flex-1 space-y-2 overflow-auto">
              {visible.map((agent) => (
                <AgentRow key={agent.agent_name} agent={agent} />
              ))}
            </ul>
          )}

          <button
            onClick={() => setShowAll((current) => !current)}
            className="mt-2 self-start text-[11px] text-agent hover:underline"
          >
            {showAll ? `Show only agents needing attention (${agents.filter(needsAttention).length})` : `Show all ${agents.length} agents`}
          </button>
          {!showAll && hiddenCount > 0 && visible.length > 0 && (
            <p className="mt-1 text-[11px] text-text-secondary">{hiddenCount} healthy or idle agent(s) hidden.</p>
          )}
        </div>
      )}
    </section>
  );
}

function AgentRow({ agent }: { agent: AgentHealthEntry }) {
  return (
    <li className="rounded-md border border-border-soft p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-text-primary" title={agent.agent_name}>
          {agent.agent_name}
        </span>
        <span
          className={`flex-shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${CIRCUIT_TONE[agent.circuit_state]}`}
        >
          {agent.circuit_state}
        </span>
      </div>
      <div className="mt-1 text-text-secondary">
        last ok {formatTime(agent.last_success_at)} · last fail {formatTime(agent.last_failure_at)} · queue {agent.queue_depth}/
        {agent.pool_size}
      </div>
      <div className="mt-0.5 text-[11px] text-text-secondary">
        {agent.invocations} calls · {agent.failures} failed · {agent.retries} retried · {agent.timeouts} timed out
      </div>
      {agent.last_error && (
        <div className="mt-1 truncate text-danger" title={agent.last_error}>
          {agent.last_error}
        </div>
      )}
    </li>
  );
}
