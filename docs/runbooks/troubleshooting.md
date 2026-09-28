# UROS Troubleshooting Runbook

Start here for any "something's wrong in production" investigation. Ends where `docs/runbooks/deploy.md` (rollback) or `docs/runbooks/backup_restore.md` (data recovery) begin.

## 1. First move: read `/health`

```bash
curl -s https://<host>/health | jq .
```

```json
{
  "status": "ok",
  "deployment_mode": "CLOUD",
  "uptime_seconds": 41302,
  "checks": { "database": "ok", "redis": "ok", "queue": "ok", "encryption": "ok" },
  "timestamp": "2026-08-24T02:00:00.000Z",
  "request_id": "..."
}
```

| Field | Meaning |
|---|---|
| `status: ok` | All checks pass. HTTP 200. |
| `status: degraded` | A non-critical component (`redis` or `queue`, when it's Redis-backed) is down. HTTP 200 — still serving traffic, but investigate before it becomes critical. |
| `status: down` | `database` or `encryption` failed. HTTP 503. **This is load-bearing** — every request needs the database (candidate data, audit trail) and encryption (BYOK credential decryption), so nothing meaningful can happen while either is down. |
| `checks.database` | `ok` / `down`. See §2. |
| `checks.redis` | `ok` / `down` / `not_configured` (expected — see `REDIS_URL` in env.schema.ts) |
| `checks.queue` | Mirrors `redis` when `REDIS_URL` is set; mirrors `database` otherwise (Postgres poll worker fallback — `src/services/queue/consumer.ts`). |
| `checks.encryption` | `ok` / `down`. See §4. Should essentially never be anything but `ok` or a hard crash at boot (`env.schema.ts` validates `ENCRYPTION_KEY` shape on startup). |

## 2. `checks.database: down`

- Check `DATABASE_URL` is correct and the database is reachable from where the API container runs (network policy, security group, firewall).
- `docker compose logs postgres` (or your managed Postgres provider's console) for the actual failure — connection refused, auth failure, out of connections, disk full.
- If it's "too many connections": UROS uses a single shared `pg.Pool` (`src/database/client.ts`) — this indicates either a connection leak (check for long-running transactions in `pg_stat_activity`) or the pool size is genuinely undersized for current load, not a `/health` bug.
- Confirm migrations have actually run (`SELECT * FROM schema_migrations ORDER BY id DESC LIMIT 5;`) — a health check failure right after a deploy sometimes means `migrate` didn't complete before `api` started; the compose files guard this with `condition: service_completed_successfully`, but a manual/non-compose deploy can skip that ordering.

## 3. `checks.redis: down` / `checks.queue: down`

- If `REDIS_URL` is unset: this is expected (`not_configured`) — the system falls back to the Postgres poll worker, and `queue` should mirror `database` instead. If you see `redis: down` with `REDIS_URL` unset, that's a bug in the deployed image version — check you're running the version documented in `progress.md`.
- If `REDIS_URL` is set and `redis: down`: check Redis is reachable, `maxmemory-policy` isn't evicting keys the queue relies on, and that `worker`/`webhook-scheduler` containers are actually running (`docker compose ps`) — a `degraded` status here means evaluation jobs and webhook retries are stalled, not lost (they're durably recorded in Postgres either way — see `src/services/queue/producer.ts` and `src/services/webhooks/scheduler.ts`), but they won't progress until Redis (or the poll worker) is back.

## 4. `checks.encryption: down`

This means `encryptSecret()`/`decryptSecret()` (`src/utils/encryption.ts`) round-tripped incorrectly against a throwaway probe string — almost always `ENCRYPTION_KEY` is missing, malformed (must be a 64-character hex string = 32 bytes for AES-256), or was rotated without re-encrypting existing BYOK credentials (`src/services/integrations/credential_store.ts`). If this just started after a deploy, check the deployed `ENCRYPTION_KEY` secret matches the one used when existing credentials were encrypted — **do not rotate `ENCRYPTION_KEY` without a re-encryption migration**, or every stored connector credential (Teletalk, bdjobs, SMS provider, BYOK LLM keys) becomes unreadable.

## 5. `/metrics` returns 401

Expected behavior when `METRICS_TOKEN` is set (see `deploy/env-templates/.env.onprem.example`) and the scrape request didn't include `Authorization: Bearer <token>` or `X-Metrics-Token: <token>`. Point your Prometheus scrape config's `bearer_token` (or `authorization.credentials`) at the same value. If you did **not** set `METRICS_TOKEN` and still get a 401, check nothing upstream (reverse proxy, ingress) is stripping the header or independently gating the path.

## 6. Elevated `uros_http_requests_total{status="429"}` in `/metrics`

Two independent rate limiters can produce a 429:
- **Global limiter** (`src/api/server.ts`, `createRateLimiter("global", 300, 60_000)`): blunt defense-in-depth, 300 req/min per key. A spike here across many routes usually means either genuine abuse or a client retry-storm bug, not a targeted attack on one endpoint.
- **Route-specific limiters** (`import`, `communication send`, etc. — see individual route files): tighter, business-meaningful throttles. A 429 concentrated on one route (e.g. `/candidates/import`) means that specific operation's limit was hit — check whether it's a legitimate large batch that needs the limit raised for this org, or a misbehaving integration retrying too fast.

Both are in-memory and per-process (`rate_limit.ts`) — in a horizontally-scaled deployment, the effective limit is `(configured limit) × (number of running instances)`, since each process tracks its own buckets independently. This is a known, accepted trade-off for this phase (no Redis-backed shared limiter yet); size limits accordingly if running more than one replica.

## 7. Elevated `uros_evaluation_jobs_total{status="failed"}`

Check the audit log — every job failure is also written there (`entity_type: EVALUATION_JOB`, `action: JOB_FAILED`, with `reason_comment`) via the same central instrumentation point (`src/utils/audit_helper.ts`), so `/metrics` tells you *that* something failed and `audit_log` tells you *why*, for a specific candidate/batch:

```sql
SELECT entity_id, reason_comment, timestamp
FROM audit_log
WHERE entity_type = 'EVALUATION_JOB' AND action = 'JOB_FAILED'
ORDER BY timestamp DESC
LIMIT 20;
```

Common causes: a malformed candidate record reaching a stage that doesn't defensively handle it (see file 18 — Error Handling and Exception Management; this should route to `Needs Review`, not crash a job — a repeated crash on the same reason is worth a bug report), or a downstream dependency (OCR, verification API) timing out.

## 8. Container won't pass its Docker `HEALTHCHECK`

`deploy/docker/healthcheck.js` only checks HTTP 200 from `/health` on `127.0.0.1:$PORT` inside the container. If `docker inspect <container>` shows `unhealthy`:
- `docker logs <container>` first — most often the process crashed at boot (check `env.schema.ts` validation errors — a missing required env var throws immediately on startup with a specific `ZodError` message identifying the field).
- If the process is running but `/health` times out: check the container's own resource limits (`deploy.resources.limits` in `docker-compose.onprem.yml`) aren't starving it, and that nothing else is bound to the same `PORT` inside the container.

## 9. Structured log correlation

Every log line includes `request_id` (see `src/api/middleware/request_id.ts` / `request_logger.ts`). Given a user-reported issue with a specific request ID (returned in the `X-Request-Id` response header, and worth asking users/integrators to quote when filing a ticket):

```bash
docker compose logs api | grep '"request_id":"<the-id>"'
```

This ties together the HTTP access log line, any error the `error_handler` logged, and (if the request touched the audit trail) the corresponding `audit_log` rows for that action — giving a full request-to-decision trace without needing a separate distributed tracing system for this phase's scope.

## 10. When none of the above resolves it

- Rollback (bad deploy): `docs/runbooks/deploy.md` §4.
- Data corruption/loss: `docs/runbooks/backup_restore.md` §3.
- Neither: escalate with the `request_id`(s) involved, the relevant `/health` and `/metrics` snapshots, and the audit log excerpt for the affected `entity_id` — this is almost always enough to reproduce the issue without needing production database access.
