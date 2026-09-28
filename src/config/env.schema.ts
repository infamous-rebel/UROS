import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production", "test"]).default("development"),
  DATABASE_URL: z.string().url().refine((v) => v.startsWith("postgres"), {
    message: "DATABASE_URL must be a postgres connection string",
  }),
  REDIS_URL: z.string().url().optional(),
  DEPLOYMENT_MODE: z.enum(["ON_PREM", "CLOUD", "HYBRID"]).default("CLOUD"),
  PORT: z.coerce.number().int().positive().default(3000),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be 64 hex chars (32 bytes) for AES-256-GCM"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  DEFAULT_OCR_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  GATE_TIMEOUT_MS: z.coerce.number().int().positive().default(1000 * 60 * 60 * 24 * 30), // 30 days
  // Security Hardening Round: explicit, env-configurable pool limits so
  // a burst of concurrent requests (e.g. a mass-recruitment batch)
  // cannot exhaust database connections or hang indefinitely waiting
  // for one.
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  WEBHOOK_SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  // --- Phase 7: Deploy & Ops hardening ---
  /** Comma-separated list of allowed browser origins for CORS. Unset = reflect any origin (dev only; set explicitly in production). */
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  /** Set true when running behind a reverse proxy/load balancer so req.ip and rate limiting see the real client IP (X-Forwarded-For). */
  // NOTE: deliberately not z.coerce.boolean() — that coerces ANY
  // non-empty string (including the literal string "false") to `true`,
  // which would silently defeat an operator explicitly setting
  // TRUST_PROXY=false. Restricting to the literal strings "true"/"false"
  // and transforming makes the invalid-value case a validation error
  // instead of a silent misconfiguration.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Optional shared secret required (as `Authorization: Bearer <token>` or `X-Metrics-Token`) to read /metrics. Unset = open (protect at network/reverse-proxy level instead, e.g. on-prem deployments behind a firewall). */
  METRICS_TOKEN: z.string().optional(),
  /** Root path where original candidate/employee documents are stored on disk (for backup/DR document sync — see scripts/backup.sh). */
  DOCUMENT_STORAGE_PATH: z.string().default("/data/uros/documents"),

  // --- Feature 3: Digital Exam Paper Creator ---
  /** Public base URL used to build a shareable digital exam link (POST /exams/:id/export?format=link). No trailing slash. */
  APP_PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  // --- Feature 4: Applicant Status Portal ---
  /** How long an applicant login OTP remains valid before it must be re-requested. */
  APPLICANT_OTP_EXPIRY_MINUTES: z.coerce.number().int().positive().default(10),

  // --- Feature 5: Multi-Language Interface and Document Support ---
  /**
   * Local filesystem directory containing Tesseract .traineddata files
   * (eng.traineddata, ben.traineddata). Unset = tesseract.js falls back
   * to its default CDN download, which is unavailable in air-gapped/
   * on-premises deployments (10_Technical_Architecture.md §9: "Supports
   * air-gapped environments"). Set this for any on-prem/air-gapped
   * install so Bangla (and English) OCR never depends on outbound
   * network access.
   */
  TESSERACT_LANG_PATH: z.string().optional(),

  // --- Feature 7: Automated Reference Checking ---
  /** How many days a reference-check link (POST /references/request) remains valid before it must be reissued. */
  REFERENCE_REQUEST_EXPIRY_DAYS: z.coerce.number().int().positive().default(14),

  // --- Agent-Level Hardening (infrastructure layer, see src/services/agent_runner) ---
  // Every value below is an operational knob for the generic agent
  // runner. They are validated here (at process start) so a typo in a
  // deployment manifest is a loud startup failure, never a silently
  // disabled timeout or a retry storm in production.

  /** Hard wall-clock ceiling for a single agent invocation, in ms. On breach the runner reports a timeout and (if the error classifies as transient) retries. The underlying work is not cancellable in Node — it is abandoned, not killed. */
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Extra attempts after the first, for transient failures only (timeout, connection reset, pool exhaustion, an error explicitly marked `retryable`). 0 disables retry. */
  AGENT_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  /** Base of the exponential backoff between attempts: attempt n waits `base * 2^n` ms (capped by AGENT_BACKOFF_MAX_MS). */
  AGENT_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(200),
  /** Upper bound on a single backoff sleep, so a high AGENT_MAX_RETRIES cannot produce a multi-minute stall. */
  AGENT_BACKOFF_MAX_MS: z.coerce.number().int().min(0).default(5_000),
  /** Consecutive failures after which an agent's circuit opens and further calls are rejected immediately instead of piling onto an already-failing dependency. */
  AGENT_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  /** How long a circuit stays OPEN before it moves to HALF_OPEN and admits a single probe invocation. A successful probe closes it; a failed probe re-opens it. */
  AGENT_CIRCUIT_RESET_MS: z.coerce.number().int().positive().default(30_000),
  /** Set "false" to stop the runner writing AGENT_INVOCATION_* rows to audit_log (structured logging and metrics are unaffected). Auditing is on by default: UROS audits everything. */
  AGENT_AUDIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // Worker pool sizes, one per agent class. Deliberately modest defaults:
  // each in-flight agent invocation holds at least one Postgres connection,
  // so the sum of all pools must stay at or below DB_POOL_MAX (20 by
  // default) or agents will block on connection acquisition instead of
  // doing work. The defaults below sum to exactly 20; loadEnv warns (never
  // fails) if an operator raises them past DB_POOL_MAX.
  AGENT_POOL_INTAKE_SIZE: z.coerce.number().int().positive().default(4),
  AGENT_POOL_PARSER_SIZE: z.coerce.number().int().positive().default(2),
  AGENT_POOL_SCANNER_SIZE: z.coerce.number().int().positive().default(2),
  AGENT_POOL_SCORING_SIZE: z.coerce.number().int().positive().default(4),
  AGENT_POOL_VERIFICATION_SIZE: z.coerce.number().int().positive().default(2),
  AGENT_POOL_COMMUNICATION_SIZE: z.coerce.number().int().positive().default(2),
  AGENT_POOL_ANALYTICS_SIZE: z.coerce.number().int().positive().default(2),
  /** Fallback class for agents that do not map onto a named pipeline stage. */
  AGENT_POOL_GENERAL_SIZE: z.coerce.number().int().positive().default(2),
  /** Max queued (not yet started) tasks per pool. Beyond this, submission is rejected outright rather than growing memory without bound. */
  AGENT_POOL_MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(1_000),

  // Resumable-batch checkpointing (crash recovery).
  /** Persist batch progress every N items. 1 = after every item (strongest resume guarantee, one extra write per item). */
  AGENT_CHECKPOINT_EVERY: z.coerce.number().int().positive().default(1),
  /** A RUNNING batch whose heartbeat is older than this is presumed to belong to a dead process and is marked INTERRUPTED so it can be resumed. */
  AGENT_BATCH_STALE_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  /** Restarts a supervised long-running loop is allowed before the supervisor gives up and exits non-zero (letting Docker/K8s restart the whole process). */
  AGENT_SUPERVISOR_MAX_RESTARTS: z.coerce.number().int().min(0).default(5),
  AGENT_SUPERVISOR_RESTART_BACKOFF_MS: z.coerce.number().int().min(0).default(1_000),
});

export type Env = z.infer<typeof EnvSchema>;

/** Agent-class pool size keys, in the same order the classes are declared. */
const POOL_SIZE_KEYS = [
  "AGENT_POOL_INTAKE_SIZE",
  "AGENT_POOL_PARSER_SIZE",
  "AGENT_POOL_SCANNER_SIZE",
  "AGENT_POOL_SCORING_SIZE",
  "AGENT_POOL_VERIFICATION_SIZE",
  "AGENT_POOL_COMMUNICATION_SIZE",
  "AGENT_POOL_ANALYTICS_SIZE",
  "AGENT_POOL_GENERAL_SIZE",
] as const;

/**
 * Cross-field startup check the schema cannot express on its own: every
 * in-flight pooled agent task ultimately holds a database connection, so a
 * pool configuration larger than DB_POOL_MAX turns agent concurrency into
 * connection-queue contention.
 *
 * A warning, not a fatal error — an operator may deliberately over-subscribe
 * (for example when most pooled work is OCR-bound rather than DB-bound), and
 * refusing to boot over a tuning choice would be worse than logging it.
 */
function warnOnOversubscribedPools(cfg: Env): void {
  const total = POOL_SIZE_KEYS.reduce((sum, key) => sum + cfg[key], 0);
  if (total > cfg.DB_POOL_MAX) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] Agent worker pools total ${total} concurrent tasks but DB_POOL_MAX is ${cfg.DB_POOL_MAX}. ` +
        `Agents may block acquiring a database connection; raise DB_POOL_MAX or lower the AGENT_POOL_*_SIZE values.`
    );
  }
}

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  warnOnOversubscribedPools(parsed.data);
  return parsed.data;
}

export const env: Env = loadEnv();
