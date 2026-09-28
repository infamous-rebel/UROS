# UROS Backup & Disaster Recovery Runbook

Covers the audit log, candidate records, rule packs, and original documents — everything file 20 §2.4 (Backup Scope) and file 19 §5 (Data Retention) require to be recoverable. All three scripts live in `scripts/` and are deliberately simple, auditable shell — no opaque backup SaaS in the critical path, consistent with UROS's no-black-box principle.

## 1. What gets backed up

`scripts/backup.sh` produces **one encrypted archive** per run containing:

| Component | Source | Format inside archive |
|---|---|---|
| Database | `DATABASE_URL` | `database.dump` — `pg_dump --format=custom` (supports `pg_restore --clean --if-exists`) |
| Original documents | `DOCUMENT_STORAGE_PATH` | `documents.tar` |
| Manifest | generated | `manifest.json` — timestamp, DB host, source path, format version |

The three are tar'd together, then encrypted with `openssl enc -aes-256-cbc -pbkdf2` under `BACKUP_ENCRYPTION_PASSPHRASE`, written to `BACKUP_OUTPUT_DIR` as `uros-backup-<UTC timestamp>.tar.enc`, alongside a `.sha256` checksum file.

**Not** included (by design, per file 20 §2.4 and this phase's scope): container images (rebuilt from source via CI, not backed up as data), Redis (the evaluation queue is re-derivable from Postgres job state — see `checkQueue()` in `src/utils/health.ts` — so Redis itself is not a system-of-record).

## 2. Running a backup

```bash
cp deploy/env-templates/.env.example .env   # ensure BACKUP_ENCRYPTION_PASSPHRASE, BACKUP_OUTPUT_DIR are set
npm run backup
# or directly:
bash scripts/backup.sh
```

### Scheduling

Not run automatically inside any container (see the commented-out `backup-once` service in `docker-compose.onprem.yml` for why — a container-internal cron adds a process supervisor UROS doesn't otherwise need). Schedule it externally:

```cron
# /etc/cron.d/uros-backup — daily at 02:00
0 2 * * * uros cd /opt/uros && ENV_FILE=/opt/uros/.env bash scripts/backup.sh >> /var/log/uros-backup.log 2>&1
```

Retention: `BACKUP_RETENTION_DAYS` (default 30 cloud / 90 on-prem) — `backup.sh` prunes older local archives automatically. Off-host copies (S3, org SAN, tape) are outside this script's scope — copy `BACKUP_OUTPUT_DIR` out after each run per your org's retention policy (file 19 §5.1: audit logs 10 years, verification reports 5 years — the *database* retention values; the *backup file* retention is an operational choice, typically much shorter, since each backup is a full point-in-time copy of data whose long-term retention already lives in the live system).

## 3. Restoring

**This overwrites the target database and document store. There is no `--force`/`--yes` shortcut on purpose.**

```bash
bash scripts/restore.sh --archive backups/uros-backup-20260824T020000Z.tar.enc --confirm
# You will be prompted to type the target database name exactly before anything happens.
```

Steps `restore.sh` performs, in order:
1. Decrypts the archive (fails loudly if `BACKUP_ENCRYPTION_PASSPHRASE` is wrong).
2. Prints the manifest (timestamp, source host) so you can confirm you have the right backup before anything is touched.
3. `pg_restore --clean --if-exists --no-owner` against `DATABASE_URL` (or `--database-url` override).
4. Replaces `DOCUMENT_STORAGE_PATH` (or `--documents-target` override) wholesale with the archive's `documents.tar`.
5. Runs `npm run migrate` (unless `--skip-migrate`) to apply anything newer than the backup.

**After restoring:** run `bash scripts/smoke_test.sh <base-url>` before resuming production traffic (see `docs/runbooks/deploy.md` §2 step 6).

### Restoring to a different target (staging copy of production data)

```bash
bash scripts/restore.sh \
  --archive backups/uros-backup-20260824T020000Z.tar.enc \
  --database-url postgres://uros:uros@staging-db:5432/uros_staging \
  --documents-target /data/uros-staging/documents \
  --confirm
```

## 4. DR drills (required every 6 months — file 20 §2.3)

`scripts/dr_drill.sh` restores the most recent (or a specified) backup into an **isolated, throwaway Postgres container** — it never touches `DATABASE_URL` — and runs integrity checks (`schema_migrations` row count, key tables reachable, document archive entry count). Safe to run against a live production backup with zero production risk.

```bash
bash scripts/dr_drill.sh                                   # uses the newest archive in BACKUP_OUTPUT_DIR
bash scripts/dr_drill.sh backups/uros-backup-<ts>.tar.enc   # or a specific one
```

Exit code `0` = PASS, non-zero = FAIL (inspect the `[FAIL]` lines).

**Record every drill result** (date, archive tested, pass/fail, who ran it) — this itself belongs in your organisation's own audit trail for compliance sign-off (file 20 §6.6), separate from UROS's own immutable `audit_log` table (which only records in-application actions, not infrastructure drills).

| Date | Archive | Result | Run by | Notes |
|---|---|---|---|---|
| _(append rows here, or track in your issue tracker / compliance system)_ | | | | |

## 5. Recovery objectives

Matches file 20 §2.3:

| Metric | Target |
|---|---|
| Recovery Time Objective (RTO) | 4 hours |
| Recovery Point Objective (RPO) | 1 hour (i.e. backup frequency should be ≥ hourly incremental / daily full in production — `scripts/backup.sh` as scheduled per §2, tuned to your actual RPO needs) |

If your RPO requires sub-daily backups, increase the cron frequency in §2 accordingly — the script itself has no fixed cadence assumption.

## 6. Encryption key handling

`BACKUP_ENCRYPTION_PASSPHRASE` is the single point of failure for every backup — losing it makes all existing backups permanently unreadable (there is no key-recovery path by design; a recoverable key would defeat the point of encrypting at rest). Store it in your organisation's own secrets manager/HSM, not in `.env` long-term for on-prem deployments (see `deploy/env-templates/.env.onprem.example`). Rotate per your org's key-rotation policy; rotating does **not** re-encrypt existing backups — old backups still need the old passphrase to restore, so keep retired passphrases in escrow for at least as long as your backup retention window.
