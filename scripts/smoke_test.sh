#!/usr/bin/env bash
set -euo pipefail

# Post-deploy smoke test — run immediately after deploying a new image
# and BEFORE routing real traffic to it (see docs/runbooks/deploy.md and
# deploy/ci-cd/github-actions/deploy.yml, which gates cutover on this
# script's exit code). Read-only: makes no writes, creates no candidates,
# resolves no gates — safe to run repeatedly against production.

BASE_URL="${1:-${SMOKE_TEST_BASE_URL:-http://localhost:3000}}"
METRICS_TOKEN="${METRICS_TOKEN:-}"

pass=0
fail=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ok() { echo "  [OK]   $1"; pass=$((pass + 1)); }
bad() { echo "  [FAIL] $1"; fail=$((fail + 1)); }

echo "[smoke] target: $BASE_URL"

echo "[smoke] GET /health"
HEALTH_STATUS="$(curl -s -o "$TMP_DIR/health.json" -w '%{http_code}' "$BASE_URL/health" || echo "000")"
if [ "$HEALTH_STATUS" = "200" ]; then
  ok "/health returned 200 (fully healthy)"
elif [ "$HEALTH_STATUS" = "503" ]; then
  bad "/health returned 503 (down) — body: $(cat "$TMP_DIR/health.json" 2>/dev/null || true)"
else
  bad "/health unreachable or unexpected status: $HEALTH_STATUS"
fi
if [ -s "$TMP_DIR/health.json" ]; then
  echo "    body: $(cat "$TMP_DIR/health.json")"
fi

echo "[smoke] GET /metrics"
if [ -n "$METRICS_TOKEN" ]; then
  METRICS_STATUS="$(curl -s -o "$TMP_DIR/metrics.txt" -w '%{http_code}' -H "Authorization: Bearer $METRICS_TOKEN" "$BASE_URL/metrics" || echo "000")"
  if [ "$METRICS_STATUS" = "200" ]; then
    ok "/metrics with token returned 200"
  else
    bad "/metrics with token returned $METRICS_STATUS (expected 200)"
  fi
  if grep -q "uros_http_requests_total" "$TMP_DIR/metrics.txt" 2>/dev/null; then
    ok "metrics body contains uros_http_requests_total"
  else
    bad "metrics body missing expected series (uros_http_requests_total)"
  fi

  echo "[smoke] GET /metrics without token (should be 401 since METRICS_TOKEN is set)"
  NOTOKEN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/metrics" || echo "000")"
  if [ "$NOTOKEN_STATUS" = "401" ]; then
    ok "/metrics without token correctly rejected (401)"
  else
    bad "/metrics without token returned $NOTOKEN_STATUS (expected 401 — METRICS_TOKEN may not be enforced)"
  fi
else
  echo "  [SKIP] METRICS_TOKEN not set in this shell — checking /metrics is reachable in open mode instead"
  METRICS_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/metrics" || echo "000")"
  if [ "$METRICS_STATUS" = "200" ]; then
    ok "/metrics reachable (open mode, 200)"
  else
    bad "/metrics returned $METRICS_STATUS (expected 200 in open mode)"
  fi
fi

echo "[smoke] GET /api/v1/candidates without Authorization header (must be 401)"
UNAUTH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/candidates" || echo "000")"
if [ "$UNAUTH_STATUS" = "401" ]; then
  ok "protected endpoint rejects missing token (401)"
else
  bad "protected endpoint returned $UNAUTH_STATUS without a token (expected 401)"
fi

echo "[smoke] GET /api/v1/candidates with an invalid token (must be 401, not 500)"
BADTOKEN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer not-a-real-token" "$BASE_URL/api/v1/candidates" || echo "000")"
if [ "$BADTOKEN_STATUS" = "401" ]; then
  ok "protected endpoint rejects invalid token (401, not a 500 crash)"
else
  bad "protected endpoint returned $BADTOKEN_STATUS with an invalid token (expected 401)"
fi

echo ""
echo "[smoke] $pass passed, $fail failed"
if [ "$fail" -eq 0 ]; then
  echo "[smoke] PASS — safe to proceed with cutover."
  exit 0
else
  echo "[smoke] FAIL — do NOT cut over traffic to this deployment."
  exit 1
fi
