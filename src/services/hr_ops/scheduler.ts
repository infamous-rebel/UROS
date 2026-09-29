import { db } from "../../database/client";
import { logger } from "../../utils/logger";
import { AGENT_NAMES, invoke } from "../agent_runner/agents";
import { runBatchIsolated } from "../agent_runner/batch";
import { registerAllProviders } from "../integrations/register_all";
import { bootstrapAgentRuntime, installProcessSupervisor } from "../agent_runner/supervisor";

// Adapters must be registered before any dispatch in this process.
registerAllProviders();

/**
 * Runs overdue-flagging and due-reminder sweeps across every org.
 * Pre-approved, low-risk, repetitive automation only — never
 * completes/approves anything.
 *
 * Agent-Level Hardening: the sweep over orgs is a batch, so it runs through
 * `runBatchIsolated` — one org whose sweep throws is logged, audited and
 * skipped while every other org is still swept. Each agent call goes
 * through the generic runner, which supplies the timeout, transient-retry,
 * circuit breaker, structured log and audit trail. The sweep's own
 * semantics (which agents run, in what order, what they are allowed to
 * touch) are unchanged.
 */
export async function runHrOpsSweep(): Promise<void> {
  const orgs = await db.query<{ org_id: string }>(`SELECT org_id FROM organizations`);

  const sweep = await runBatchIsolated({
    agentName: "hr_ops.org_sweep",
    items: orgs.rows,
    itemKey: (row) => row.org_id,
    actor: "HrOpsScheduler",
    entity_type: "ORGANIZATION",
    processItem: async ({ org_id }) => {
      const overdueTasks = await invoke(
        AGENT_NAMES.TASK_LOG_FLAG_OVERDUE,
        { org_id },
        { actor: "HrOpsScheduler", entity_type: "ORGANIZATION", entity_id: org_id }
      );
      const remindersSent = await invoke(
        AGENT_NAMES.TASK_LOG_SEND_REMINDERS,
        { org_id },
        { actor: "HrOpsScheduler", entity_type: "ORGANIZATION", entity_id: org_id }
      );
      logger.info("HR_OPS_SWEEP", { org_id, overdueTasks, remindersSent });
    },
  });

  if (sweep.failed > 0) {
    // Never a silent partial sweep: an operator reading the logs must be
    // able to see which orgs were not swept and why.
    logger.error("HR_OPS_SWEEP_PARTIAL", {
      orgs_total: sweep.total,
      orgs_swept: sweep.ok,
      orgs_failed: sweep.failed,
      failures: sweep.failures,
    });
  }

  const overdueOnboarding = await invoke(
    AGENT_NAMES.ONBOARDING_FLAG_OVERDUE,
    {},
    { actor: "HrOpsScheduler", entity_type: "ONBOARDING", entity_id: "all-orgs" }
  );
  logger.info("HR_OPS_SWEEP_ONBOARDING", { overdueOnboarding });
}

let handle: NodeJS.Timeout | null = null;

/**
 * Starts the polling loop. Idempotent — calling twice is a no-op.
 *
 * `keepProcessAlive` matters only for the standalone scheduler process:
 * an unref'd interval lets Node exit as soon as the loop is installed,
 * which under a container `restart` policy looks like an endless
 * instant-exit crash loop. In-process callers (the API booting the sweep
 * alongside its HTTP server) keep the default, so the timer never holds
 * the process open on its own.
 */
export function startHrOpsScheduler(
  intervalMs: number = 60 * 60_000,
  keepProcessAlive: boolean = false
): void {
  if (handle) return;
  logger.info("HR_OPS_SCHEDULER_STARTED", { intervalMs });
  handle = setInterval(() => {
    runHrOpsSweep().catch((err) => logger.error("HR_OPS_SWEEP_FAILED", { error: String(err) }));
  }, intervalMs);
  if (!keepProcessAlive) handle.unref();
}

export function stopHrOpsScheduler(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

if (require.main === module) {
  installProcessSupervisor();
  void bootstrapAgentRuntime()
    .catch((err) => logger.error("AGENT_RUNTIME_BOOTSTRAP_FAILED", { error: String(err) }))
    .finally(() => startHrOpsScheduler(60 * 60_000, true));
}
