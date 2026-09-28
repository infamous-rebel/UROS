# UROS Deploy Runbook

Deterministic, human-in-the-loop deploys. No step in this runbook auto-promotes a build past a human checkpoint (the "Approve deployment" GitHub Environment gate) or past the smoke test — consistent with UROS's own product principle that agents recommend and humans decide, applied here to UROS's own infrastructure.

## 1. Environments

| Environment | Compose file | Notes |
|---|---|---|
| Local dev | `deploy/docker/docker-compose.yml` | `.env` from `deploy/env-templates/.env.example` |
| Cloud staging/production | `deploy/docker/docker-compose.yml` | Postgres/Redis may instead be managed services — see §5 |
| On-premises (government/bank) | `deploy/docker/docker-compose.onprem.yml` | Host bind-mounts, internal-only network, air-gap notes inline in the file |

## 2. Standard deploy (via GitHub Actions)

The pipeline is `deploy/ci-cd/github-actions/deploy.yml` (mirrored at `.github/workflows/deploy.yml`, which is what GitHub actually runs from).

1. Merge to `main`, or run the workflow manually (`workflow_dispatch`) choosing `environment: staging` or `production`.
2. **CI gate**: lint → typecheck → test (with coverage) → `npm audit` (advisory, non-blocking) → build API dist → build UI dist. Any failure stops the pipeline here — nothing is pushed.
3. **Build & push**: API and UI images built and pushed to GHCR, tagged with the git SHA (immutable rollback target) and `latest`.
4. **Migrate**: `npm run migrate` runs against the target `DATABASE_URL` secret. Migrations are idempotent — `schema_migrations` tracks applied files (`src/database/migrate.ts`) — so re-running is always safe.
5. **Deploy**: the new image is promoted. The workflow's `deploy` job is intentionally a documented stub — plug in your actual mechanism (SSH + `docker compose pull && up -d`, or your cloud provider's deploy CLI/API). GitHub Environments' required-reviewer protection rule is the human approval gate for `production`.
6. **Smoke test**: `scripts/smoke_test.sh` runs against the deployed base URL. Checks `/health` (200), `/metrics` (200 with `METRICS_TOKEN`, 401 without one — proving the token gate is enforced), and that `/api/v1/candidates` returns `401` both with no token and with a garbage token (never a 500). **A failing smoke test blocks cutover** — do not manually route traffic to a build that failed this step.

## 3. Manual deploy (no CI/CD runner available)

```bash
cp deploy/env-templates/.env.example .env   # or .env.onprem.example
# fill in real secrets — see docs/runbooks/troubleshooting.md if unsure which vars are required

docker compose -f deploy/docker/docker-compose.yml --env-file .env up -d --build
# `migrate` runs to completion automatically before api/worker/schedulers start
# (condition: service_completed_successfully in the compose file).

bash scripts/smoke_test.sh http://localhost:3000
```

For on-premises:

```bash
mkdir -p data/postgres data/redis data/documents backups
cp deploy/env-templates/.env.onprem.example .env
docker compose -f deploy/docker/docker-compose.onprem.yml --env-file .env up -d --build
bash scripts/smoke_test.sh http://localhost:8080   # via the UI's nginx proxy — api has no published port on-prem
```

## 4. Rollback

Two independent things can go wrong, and they roll back differently:

### 4.1 Application rollback (bad image, smoke test failed)

Re-run `deploy.yml` via `workflow_dispatch` with `rollback_to_tag` set to the last known-good image tag (a git SHA — check the `deploy-history-<environment>` workflow artifact, or `git log` on `main`). This job:
- Skips CI and image build entirely (reuses the already-pushed image).
- **Does not re-run migrations** (see §4.2 for why).
- Re-runs the smoke test against the reverted deployment.

Manual equivalent:
```bash
IMAGE_TAG=<previous-good-sha> docker compose -f deploy/docker/docker-compose.yml --env-file .env up -d --no-build
bash scripts/smoke_test.sh http://localhost:3000
```

### 4.2 Migration policy — why rollback never reverts schema changes

UROS migrations are forward-only (`src/database/migrate.ts` applies numbered files in order; there is no auto-generated "down" migration). Practically, this means:

- **Every migration must be backward compatible with the previous application release for at least one full deploy cycle.** Add columns/tables; don't rename or drop a column the previous release still reads/writes in the same release that removes the old usage. Split breaking schema changes into an "expand" migration (ship first, old and new code both work) and a later "contract" migration (ship only after the old code path is fully retired) — run the expand step ahead of time with `deploy/ci-cd/github-actions/migrate.yml` if needed.
- If a rollback is needed, rolling back the **application image** to the previous tag is sufficient and safe, because that previous code was already written to tolerate the current schema.
- If a migration itself is the problem (bad data, wrong constraint), write and run a new forward migration that corrects it — don't hand-edit the database, and don't attempt to "undo" via manual DDL outside the tracked migration files, or `schema_migrations` and the live schema will drift apart silently.

### 4.3 Full disaster recovery (data loss / corruption)

See `docs/runbooks/backup_restore.md`. That is a separate, more invasive procedure (`scripts/restore.sh`, requires explicit `--confirm` and typing the target database name) and should only be used when rollback (§4.1) is not the problem.

## 5. Managed Postgres/Redis (cloud)

`docker-compose.yml` ships with containerized Postgres/Redis for a self-contained cloud/staging environment. For production, pointing `DATABASE_URL` / `REDIS_URL` at a managed service (RDS, Cloud SQL, ElastiCache, etc.) is equally supported — the app only depends on the connection string via `env.schema.ts`, not on how Postgres/Redis are hosted. Drop the `postgres`/`redis` services from the compose file (or don't reference them) in that case; `migrate`/`api`/`worker` still depend on `DATABASE_URL` being reachable, not on the specific service name.

## 6. Pre-flight checklist (before any production deploy)

- [ ] CI green (lint, typecheck, test, build) on the exact commit being deployed.
- [ ] `npm audit` findings reviewed (advisory-only in CI — doesn't block, but don't ignore a new `critical`).
- [ ] Migration reviewed for backward compatibility (§4.2) if the release includes one.
- [ ] `JWT_SECRET`, `ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_PASSPHRASE` are set from a secrets manager, not this repo, and are not reused across environments.
- [ ] `CORS_ALLOWED_ORIGINS` set explicitly for production (unset reflects any origin — fine for local dev only).
- [ ] `METRICS_TOKEN` set if `/metrics` is reachable from anywhere broader than a trusted internal network.
- [ ] A recent backup exists and has passed a DR drill (`scripts/dr_drill.sh`) — see `docs/runbooks/backup_restore.md` §4.
- [ ] GitHub Environment protection rule (required reviewer) configured for `production`.
