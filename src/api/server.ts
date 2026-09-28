import express, { Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "../config/env.schema";
import { logger } from "../utils/logger";
import { requestId } from "./middleware/request_id";
import { requestLogger } from "./middleware/request_logger";
import { errorHandler } from "./middleware/error_handler";
import { createRateLimiter } from "./middleware/rate_limit";
import { buildHealthReport, httpStatusForHealth } from "../utils/health";
import { renderMetrics } from "../utils/metrics";
import { registerAllAgents } from "../services/agent_runner/agents";
import { bootstrapAgentRuntime, installProcessSupervisor } from "../services/agent_runner/supervisor";

import applicationsRoutes from "./routes/applications.routes";
import candidatesRoutes from "./routes/candidates.routes";
import evaluationsRoutes from "./routes/evaluations.routes";
import gatesRoutes from "./routes/gates.routes";
import communicationsRoutes from "./routes/communications.routes";
import auditRoutes from "./routes/audit.routes";
import reportsRoutes from "./routes/reports.routes";
import appealsRoutes from "./routes/appeals.routes";
import rulesRoutes from "./routes/rules.routes";
import webhooksRoutes from "./routes/webhooks.routes";
import credentialsRoutes from "./routes/credentials.routes";
import taskLogsRoutes from "./routes/task_logs.routes";
import onboardingRoutes from "./routes/onboarding.routes";
import kpiRoutes from "./routes/kpi.routes";
import personasRoutes from "./routes/personas.routes";
import improvementsRoutes from "./routes/improvements.routes";
import dimensionsRoutes from "./routes/dimensions.routes";
import mcqRoutes from "./routes/mcq.routes";
import examsRoutes from "./routes/exams.routes";
import applicantPortalRoutes from "./routes/applicant_portal.routes";
import fraudRoutes from "./routes/fraud.routes";
import i18nRoutes from "./routes/i18n.routes";
import usersRoutes from "./routes/users.routes";
import organizationsRoutes from "./routes/organizations.routes";
import referenceRoutes from "./routes/reference.routes";
import analyticsRoutes from "./routes/analytics.routes";
import offboardingRoutes from "./routes/offboarding.routes";
import rediscoveryRoutes from "./routes/rediscovery.routes";

/**
 * Global, generous defense-in-depth rate limit applied to every request
 * (401/health/metrics included), in addition to the tighter per-route
 * presets (`importRateLimit`, `communicationSendRateLimit`, etc.) applied
 * individually within each route file. This one exists to blunt blunt-
 * force abuse and accidental retry storms; the route-specific limiters
 * remain the meaningful business-level throttle.
 */
const globalRateLimit = createRateLimiter("global", 300, 60_000);

// Register every agent with the generic runner at module load, so the
// resilience layer (timeout / retry / circuit breaker / audit / metrics) is
// in place before the first request arrives and `/health` can enumerate all
// agents even if none has been invoked yet. Synchronous and side-effect-free
// beyond populating an in-memory registry.
registerAllAgents();

function isMetricsAuthorized(req: express.Request): boolean {
  if (!env.METRICS_TOKEN) return true; // open by default; protect via network/reverse-proxy in production
  const header = req.headers.authorization;
  const bearer = header && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
  const custom = req.headers["x-metrics-token"];
  const provided = bearer ?? (typeof custom === "string" ? custom : undefined);
  return provided === env.METRICS_TOKEN;
}

export function createApp(): Express {
  const app = express();

  // Required for req.ip / rate limiting to see the real client address
  // when UROS sits behind a load balancer, reverse proxy, or Kubernetes
  // ingress (X-Forwarded-For). Off by default so a naive deployment
  // without a trusted proxy in front cannot have its rate limits and
  // audit-logged IPs spoofed via a forged header.
  if (env.TRUST_PROXY) app.set("trust proxy", true);

  app.use(helmet());
  app.use(
    cors(
      env.CORS_ALLOWED_ORIGINS
        ? { origin: env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) }
        : undefined
    )
  );
  app.use(requestId);
  app.use(requestLogger);
  app.use(globalRateLimit);

  app.get("/health", async (req, res) => {
    const report = await buildHealthReport(req.requestId);
    res.status(httpStatusForHealth(report.status)).json(report);
  });

  app.get("/metrics", (req, res) => {
    if (!isMetricsAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(renderMetrics());
  });

  // Mounted BEFORE express.json(): this route needs the raw request body
  // for HMAC signature verification, so it cannot sit behind the global
  // JSON body parser (which would consume the stream first).
  app.use("/api/v1/webhooks", webhooksRoutes);

  app.use(express.json({ limit: "5mb" }));

  const v1 = express.Router();
  v1.use("/applications", applicationsRoutes);
  v1.use("/candidates", candidatesRoutes);
  v1.use("/evaluations", evaluationsRoutes);
  v1.use("/gates", gatesRoutes);
  v1.use("/communications", communicationsRoutes);
  v1.use("/audit-logs", auditRoutes);
  v1.use("/reports", reportsRoutes);
  v1.use("/appeals", appealsRoutes);
  v1.use("/rules", rulesRoutes);
  v1.use("/credentials", credentialsRoutes);
  v1.use("/task-logs", taskLogsRoutes);
  v1.use("/onboarding", onboardingRoutes);
  v1.use("/kpi", kpiRoutes);
  v1.use("/personas", personasRoutes);
  v1.use("/improvements", improvementsRoutes);
  v1.use("/dimensions", dimensionsRoutes);
  v1.use("/mcq", mcqRoutes);
  v1.use("/exams", examsRoutes);
  v1.use("/fraud", fraudRoutes);
  // Feature 7: Automated Reference Checking. POST /respond/:token inside
  // this router is intentionally public (referee has no UROS account) —
  // see reference.routes.ts header.
  v1.use("/references", referenceRoutes);
  // Feature 8: Recruitment Analytics & Source Effectiveness. Read-only
  // reporting; never writes a recruitment decision.
  v1.use("/analytics", analyticsRoutes);
  // Feature 9: Offboarding & Exit Management. Extends the onboarding
  // module's template -> instantiated-checklist pattern with mandatory
  // human approval of every step closure.
  v1.use("/offboarding", offboardingRoutes);
  // Feature 10: Candidate Rediscovery / Talent Pool Re-engagement.
  // POST /consent inside this router is intentionally reachable without
  // a staff JWT (candidate self-service via a signed per-candidate
  // token) — see rediscovery.routes.ts header for the dual-mode design.
  v1.use("/rediscovery", rediscoveryRoutes);
  // Separate from the main dashboard API surface above: no route in this
  // router requires a staff JWT — see applicant_portal.routes.ts header.
  v1.use("/portal", applicantPortalRoutes);
  // Feature 5: Multi-Language Interface and Document Support.
  // /i18n/translations is intentionally public — see i18n.routes.ts header.
  v1.use("/i18n", i18nRoutes);
  v1.use("/users", usersRoutes);
  v1.use("/organizations", organizationsRoutes);

  app.use("/api/v1", v1);

  // 404 for unmatched routes
  app.use((req, res) => {
    res.status(404).json({ error: "Not found", path: req.originalUrl });
  });

  // Must be registered last
  app.use(errorHandler);

  return app;
}

if (require.main === module) {
  const app = createApp();

  // Agent-Level Hardening: process supervision. Installs SIGTERM/SIGINT
  // graceful shutdown (in-flight resumable batches are marked INTERRUPTED so
  // the next process resumes them) and fail-loud handlers for uncaught
  // errors, then reclaims batches orphaned by a previous crash. Pairs with
  // the container `restart: unless-stopped` policy in deploy/docker.
  installProcessSupervisor();

  bootstrapAgentRuntime()
    .then(({ agents_registered, batches_reclaimed }) => {
      app.listen(env.PORT, () => {
        logger.info(`UROS API listening on port ${env.PORT}`, {
          deployment_mode: env.DEPLOYMENT_MODE,
          node_env: env.NODE_ENV,
          agents_registered,
          batches_reclaimed,
        });
      });
    })
    .catch((err) => {
      // Recovery is best-effort: a missing agent_batch_progress table must
      // not stop the API from serving. Log loudly and start anyway.
      logger.error("AGENT_RUNTIME_BOOTSTRAP_FAILED", {
        error: err instanceof Error ? err.message : String(err),
      });
      app.listen(env.PORT, () => {
        logger.info(`UROS API listening on port ${env.PORT} (agent runtime bootstrap degraded)`, {
          deployment_mode: env.DEPLOYMENT_MODE,
          node_env: env.NODE_ENV,
        });
      });
    });
}
