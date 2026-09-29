#!/usr/bin/env bash
# Quest 05 Checkpoint A — live auth E2E against a running UROS API.
#
# Usage: BASE=http://localhost:3000 DB=postgres://uros:uros@localhost:5443/uros scripts/auth_e2e.sh
#
# Exercises the full Decision Lock 1 + 2 lifecycle over real HTTP:
#   blocked login (password_reset_required) → anti-enumeration shape →
#   link verify → confirm → login → session list → refresh rotation →
#   replay-theft response → logout → dead token.
set -euo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
DB="${DB:-postgres://uros:uros@localhost:5443/uros}"
NEWPW="Ops-Bootstrap-77"

step() { printf '\n── %s\n' "$1"; }

# Repeatability: once the admin has completed bootstrap, the seed stops
# issuing links (by design). For local evidence runs, reset the demo
# admin to its pre-bootstrap state first — a no-op on fresh installs and
# skipped silently wherever the local docker container is absent.
docker exec qoder-test-postgres psql -U uros -d "${DB##*/}" -c \
  "UPDATE users SET password_hash=NULL, password_reset_required=true WHERE email='admin@demobank.example.com';" >/dev/null 2>&1 || true

# 0. Fresh bootstrap link from the seed run (in-person handoff, printed once).
step "0. seed issues first-admin set-password link"
LINK=$(DATABASE_URL="$DB" npm run --silent seed 2>/dev/null | grep -o 'reset-password?token=[A-Za-z0-9_-]*' | tail -1 || true)
if [ -z "${LINK:-}" ]; then echo "No bootstrap link issued (admin already set up and no local reset possible)."; exit 1; fi
TOKEN="${LINK##*token=}"
echo "token: ${TOKEN:0:12}…"

step "1. login is BLOCKED while password_reset_required (403 PASSWORD_RESET_REQUIRED)"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@demobank.example.com","password":"not-the-password"}'

step "2. unknown email returns the SAME 401 shape (anti-enumeration)"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"nobody@demobank.example.com","password":"not-the-password"}'

step "3. verify the link (marks clicked)"
curl -s -w '\nHTTP %{http_code}\n' "$BASE/auth/password/reset/verify?token=$TOKEN"

step "4. confirm sets the password (consumes the link)"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/auth/password/reset/confirm" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"new_password\":\"$NEWPW\"}"

step "5. login with the new password"
curl -s -D /tmp/e2e_login_h -o /tmp/e2e_login_b -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@demobank.example.com\",\"password\":\"$NEWPW\"}"
grep -i '^set-cookie: uros_refresh' /tmp/e2e_login_h | sed 's/^\(.\{96\}\).*/\1…/'
AT=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/tmp/e2e_login_b','utf8')).access_token)")
echo "access_token: ${AT:0:24}…"

step "6. GET /users/me/sessions with the session-bound access token"
curl -s -w '\nHTTP %{http_code}\n' "$BASE/users/me/sessions" -H "Authorization: Bearer $AT"

step "7. refresh rotates the cookie"
COOKIE1=$(grep -i '^set-cookie: uros_refresh' /tmp/e2e_login_h | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1)
curl -s -D /tmp/e2e_ref_h -o /tmp/e2e_ref_b -X POST "$BASE/auth/refresh" -H "Cookie: $COOKIE1"
COOKIE2=$(grep -i '^set-cookie: uros_refresh' /tmp/e2e_ref_h | sed 's/^[Ss]et-[Cc]ookie: *//' | cut -d';' -f1)
[ -n "$COOKIE2" ] && [ "$COOKIE1" != "$COOKIE2" ] && echo "cookie rotated: yes" || { echo "cookie rotated: NO"; exit 1; }
AT2=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/tmp/e2e_ref_b','utf8')).access_token)")

step "7b. replaying the OLD cookie revokes the whole session (theft response)"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/auth/refresh" -H "Cookie: $COOKIE1"

step "7c. the pre-rotation access token is dead (401 SESSION_ENDED)"
curl -s -w '\nHTTP %{http_code}\n' "$BASE/users/me/sessions" -H "Authorization: Bearer $AT"

step "8. fresh login, then logout revokes that session"
curl -s -D /tmp/e2e_l3_h -o /tmp/e2e_l3_b -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@demobank.example.com\",\"password\":\"$NEWPW\"}"
AT3=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/tmp/e2e_l3_b','utf8')).access_token)")
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/auth/logout" -H "Authorization: Bearer $AT3"

step "8b. token after logout is dead"
curl -s -w '\nHTTP %{http_code}\n' "$BASE/users/me/sessions" -H "Authorization: Bearer $AT3"

printf '\n═══ Checkpoint A E2E complete ═══\n'
