#!/usr/bin/env bash
set -euo pipefail

# UROS backup: pg_dump (custom format, via pg_restore-compatible dump) +
# a snapshot of the original-document directory, packaged into one tar
# and encrypted at rest with AES-256-CBC (openssl, PBKDF2-stretched
# passphrase). Human-in-the-loop stays in scope for infrastructure too:
# this script only ever *produces* an artifact — restoring into a live
# system is always a separate, explicit, operator-run step requiring
# --confirm (see restore.sh + docs/runbooks/backup_restore.md).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set (in .env or environment)}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE must be set}"
DOCUMENT_STORAGE_PATH="${DOCUMENT_STORAGE_PATH:-/data/uros/documents}"
BACKUP_OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-$ROOT_DIR/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$BACKUP_OUTPUT_DIR"

echo "[backup] $TIMESTAMP — dumping database..."
# Custom format (-Fc): compressed, supports pg_restore --clean/--if-exists
# and selective restore; this is the format restore.sh/dr_drill.sh expect.
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump --format=custom --file="$WORK_DIR/database.dump" "$DATABASE_URL"
else
  echo "[backup] pg_dump not found on PATH — running via a throwaway postgres:16-alpine container"
  docker run --rm --network host postgres:16-alpine \
    pg_dump --format=custom --dbname="$DATABASE_URL" --file=/dev/stdout > "$WORK_DIR/database.dump"
fi

echo "[backup] snapshotting documents from $DOCUMENT_STORAGE_PATH..."
if [ -d "$DOCUMENT_STORAGE_PATH" ]; then
  tar -C "$(dirname "$DOCUMENT_STORAGE_PATH")" -cf "$WORK_DIR/documents.tar" "$(basename "$DOCUMENT_STORAGE_PATH")"
else
  echo "[backup] WARNING: $DOCUMENT_STORAGE_PATH not found on this host — writing an empty document archive (expected if this host doesn't hold the bind-mounted document volume, or nothing has been uploaded yet)"
  tar -cf "$WORK_DIR/documents.tar" --files-from=/dev/null
fi

DB_HOST="$(echo "$DATABASE_URL" | sed -E 's#.*@([^:/]+).*#\1#')"
cat > "$WORK_DIR/manifest.json" <<JSON
{
  "backup_created_at": "$TIMESTAMP",
  "database_host": "$DB_HOST",
  "document_storage_path": "$DOCUMENT_STORAGE_PATH",
  "format": "pg_dump custom + tar, AES-256-CBC(PBKDF2) encrypted",
  "uros_phase": "7"
}
JSON

ARCHIVE="$WORK_DIR/uros-backup-$TIMESTAMP.tar"
tar -C "$WORK_DIR" -cf "$ARCHIVE" database.dump documents.tar manifest.json

ENCRYPTED_OUT="$BACKUP_OUTPUT_DIR/uros-backup-$TIMESTAMP.tar.enc"
echo "[backup] encrypting archive (AES-256-CBC, PBKDF2, 100000 iterations)..."
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
  -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
  -in "$ARCHIVE" -out "$ENCRYPTED_OUT"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ENCRYPTED_OUT" > "$ENCRYPTED_OUT.sha256"
else
  shasum -a 256 "$ENCRYPTED_OUT" > "$ENCRYPTED_OUT.sha256"
fi

echo "[backup] wrote $ENCRYPTED_OUT"
echo "[backup] checksum: $(cat "$ENCRYPTED_OUT.sha256")"

if [ -n "$BACKUP_RETENTION_DAYS" ]; then
  echo "[backup] pruning backups older than $BACKUP_RETENTION_DAYS days from $BACKUP_OUTPUT_DIR..."
  find "$BACKUP_OUTPUT_DIR" -name 'uros-backup-*.tar.enc*' -mtime "+$BACKUP_RETENTION_DAYS" -print -delete || true
fi

echo "[backup] done."
