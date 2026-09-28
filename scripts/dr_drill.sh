#!/usr/bin/env bash
set -euo pipefail

# DR drill: restores the most recent (or a specified) backup into an
# ISOLATED, throwaway Postgres container — never the real DATABASE_URL —
# and runs basic integrity checks. Safe to run against production
# backups with zero risk to the live system; nothing in this script
# writes to the configured DATABASE_URL. Intended to run on a schedule
# (file 20 §2.3: "DR drill every 6 months") and after any change to
# backup.sh/restore.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE must be set}"
BACKUP_OUTPUT_DIR="${BACKUP_OUTPUT_DIR:-$ROOT_DIR/backups}"

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(ls -t "$BACKUP_OUTPUT_DIR"/uros-backup-*.tar.enc 2>/dev/null | head -n1 || true)"
fi
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "No backup archive found in $BACKUP_OUTPUT_DIR (pass one explicitly: $0 <path>)."
  exit 1
fi

echo "[dr-drill] using archive: $ARCHIVE"

DRILL_CONTAINER="uros-dr-drill-pg-$$"
DRILL_PORT="${DR_DRILL_PORT:-55432}"
DRILL_DB_URL="postgres://uros:drill@127.0.0.1:${DRILL_PORT}/uros"
WORK_DIR="$(mktemp -d)"

cleanup() {
  echo "[dr-drill] tearing down drill container and temp files..."
  docker rm -f "$DRILL_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "[dr-drill] starting isolated Postgres container on port $DRILL_PORT..."
docker run -d --name "$DRILL_CONTAINER" \
  -e POSTGRES_USER=uros -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=uros \
  -p "${DRILL_PORT}:5432" postgres:16-alpine >/dev/null

echo -n "[dr-drill] waiting for drill database to accept connections"
READY="false"
for _ in $(seq 1 30); do
  if docker exec "$DRILL_CONTAINER" pg_isready -U uros -d uros >/dev/null 2>&1; then
    READY="true"
    echo " ready."
    break
  fi
  echo -n "."
  sleep 1
done
if [ "$READY" != "true" ]; then
  echo ""
  echo "[dr-drill] FAIL — drill Postgres container never became ready."
  exit 1
fi

echo "[dr-drill] decrypting archive..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -pass env:BACKUP_ENCRYPTION_PASSPHRASE \
  -in "$ARCHIVE" -out "$WORK_DIR/uros-backup.tar"
tar -C "$WORK_DIR" -xf "$WORK_DIR/uros-backup.tar"

echo "[dr-drill] restoring dump into drill database..."
pg_restore --no-owner --dbname="$DRILL_DB_URL" "$WORK_DIR/database.dump"

echo "[dr-drill] running integrity checks..."
CHECKS_PASSED="true"

check_query() {
  local label="$1" sql="$2"
  local result
  if result="$(docker exec "$DRILL_CONTAINER" psql -U uros -d uros -tAc "$sql" 2>&1)"; then
    echo "  [OK]   $label = $(echo "$result" | tr -d '[:space:]')"
  else
    echo "  [FAIL] $label — query errored: $result"
    CHECKS_PASSED="false"
  fi
}

check_query "schema_migrations count"       "SELECT count(*) FROM schema_migrations;"
check_query "organizations table reachable" "SELECT count(*) FROM organizations;"
check_query "audit_log table reachable"     "SELECT count(*) FROM audit_log;"
check_query "audit_log row count"           "SELECT count(*) FROM audit_log;"

if [ -f "$WORK_DIR/documents.tar" ]; then
  DOC_FILE_COUNT="$(tar -tf "$WORK_DIR/documents.tar" | wc -l | tr -d ' ')"
  echo "  [OK]   documents archive contains $DOC_FILE_COUNT entries"
fi

echo ""
if [ "$CHECKS_PASSED" = "true" ]; then
  echo "[dr-drill] PASS — $ARCHIVE is restorable and internally consistent."
  echo "[dr-drill] Record this result (date, archive, pass/fail) per the DR drill log in docs/runbooks/backup_restore.md."
  exit 0
else
  echo "[dr-drill] FAIL — see above. Investigate before relying on this backup."
  exit 1
fi
