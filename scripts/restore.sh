#!/usr/bin/env bash
set -euo pipefail

# UROS restore — HUMAN-IN-THE-LOOP BY DESIGN.
# Never runs against a target database without explicit, deliberate
# operator confirmation: requires --confirm AND typing the target
# database name back, mirroring UROS's own "override requires a mandatory
# reason" pattern (file 16 §4) applied to its own infrastructure. There
# is no --force / --yes shortcut on purpose.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<USAGE
Usage: $0 --archive <path-to-uros-backup-*.tar.enc> --confirm [options]

  --archive <path>            Required. Encrypted backup produced by backup.sh
  --confirm                   Required. Acknowledges this OVERWRITES the target database/documents.
  --database-url <url>        Overrides DATABASE_URL from .env for the restore target
  --documents-target <path>   Overrides DOCUMENT_STORAGE_PATH from .env for the restore target
  --skip-migrate               Skip running 'npm run migrate' after restore (not recommended)
USAGE
  exit 1
}

ARCHIVE=""
CONFIRM="false"
DB_URL_OVERRIDE=""
DOCS_TARGET_OVERRIDE=""
SKIP_MIGRATE="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE="$2"; shift 2 ;;
    --confirm) CONFIRM="true"; shift ;;
    --database-url) DB_URL_OVERRIDE="$2"; shift 2 ;;
    --documents-target) DOCS_TARGET_OVERRIDE="$2"; shift 2 ;;
    --skip-migrate) SKIP_MIGRATE="true"; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1"; usage ;;
  esac
done

[ -n "$ARCHIVE" ] || usage
[ -f "$ARCHIVE" ] || { echo "Archive not found: $ARCHIVE"; exit 1; }
if [ "$CONFIRM" != "true" ]; then
  echo "Refusing to restore without --confirm. This operation overwrites the target database and document store."
  usage
fi

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE must be set}"
DATABASE_URL="${DB_URL_OVERRIDE:-${DATABASE_URL:?DATABASE_URL must be set}}"
DOCUMENT_STORAGE_PATH="${DOCS_TARGET_OVERRIDE:-${DOCUMENT_STORAGE_PATH:-/data/uros/documents}}"

TARGET_DB_NAME="$(echo "$DATABASE_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')"
echo "This will OVERWRITE database '$TARGET_DB_NAME' and documents at '$DOCUMENT_STORAGE_PATH'."
echo "Archive: $ARCHIVE"
read -r -p "Type the database name exactly ('$TARGET_DB_NAME') to proceed: " TYPED
if [ "$TYPED" != "$TARGET_DB_NAME" ]; then
  echo "Confirmation text did not match. Aborting — no changes made."
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "[restore] decrypting archive..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
  -in "$ARCHIVE" -out "$WORK_DIR/uros-backup.tar"

tar -C "$WORK_DIR" -xf "$WORK_DIR/uros-backup.tar"

if [ -f "$WORK_DIR/manifest.json" ]; then
  echo "[restore] manifest:"
  cat "$WORK_DIR/manifest.json"
fi

echo "[restore] restoring database (pg_restore --clean --if-exists --no-owner)..."
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$WORK_DIR/database.dump"

echo "[restore] restoring documents to $DOCUMENT_STORAGE_PATH..."
mkdir -p "$(dirname "$DOCUMENT_STORAGE_PATH")"
rm -rf "$DOCUMENT_STORAGE_PATH"
tar -C "$(dirname "$DOCUMENT_STORAGE_PATH")" -xf "$WORK_DIR/documents.tar"

if [ "$SKIP_MIGRATE" != "true" ]; then
  echo "[restore] applying any migrations newer than this backup..."
  ( cd "$ROOT_DIR" && DATABASE_URL="$DATABASE_URL" npm run migrate )
else
  echo "[restore] --skip-migrate set: not running migrations. Run 'npm run migrate' manually before serving traffic."
fi

echo "[restore] done. Verify with scripts/smoke_test.sh before resuming traffic."
