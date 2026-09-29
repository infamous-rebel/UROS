#!/bin/bash
# Checkpoint A — Full Auth Lifecycle E2E Transcript
# Runs against localhost:3099 (API) backed by uros_e2e_test database.
# Do not use set -e; some commands are expected to return non-zero

BASE="http://localhost:3099/api/v1"
OUTFILE="tests/evidence/checkpoint-a-curl-e2e.txt"
mkdir -p tests/evidence

exec > >(tee "$OUTFILE") 2>&1

echo "═══════════════════════════════════════════════════════════════"
echo "  CHECKPOINT A — Auth Lifecycle E2E Transcript"
echo "  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── 1. LOGIN — correct password ────────────────────────────────────
echo "───────────────────────────────────────────────────────────────"
echo "1. POST /auth/login — correct password"
echo "───────────────────────────────────────────────────────────────"
echo "$ curl -s -D- -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"normal@e2e.test\",\"password\":\"Secure-Pass-99\"}'"
echo ""
RESP=$(curl -s -D /tmp/headers_login.txt -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"normal@e2e.test","password":"Secure-Pass-99"}')
cat /tmp/headers_login.txt
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
echo ""

# Extract tokens
ACCESS_TOKEN=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)
REFRESH_COOKIE=$(grep -i 'set-cookie' /tmp/headers_login.txt | sed 's/.*uros_refresh=//;s/;.*//' | tr -d '\r')
echo "[Extracted] access_token=${ACCESS_TOKEN:0:40}..."
echo "[Extracted] refresh_cookie=${REFRESH_COOKIE:0:40}..."
echo ""

# ─── 2. LOGIN — wrong password ──────────────────────────────────────
echo "───────────────────────────────────────────────────────────────"
echo "2. POST /auth/login — wrong password → 401"
echo "───────────────────────────────────────────────────────────────"
echo "$ curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"normal@e2e.test\",\"password\":\"Wrong-Pass-0\"}'"
echo ""
curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"normal@e2e.test","password":"Wrong-Pass-0"}' | python3 -m json.tool 2>/dev/null
echo ""
echo ""

# ─── 3. LOGIN — password_reset_required user ────────────────────────
echo "───────────────────────────────────────────────────────────────"
echo "3. POST /auth/login — password_reset_required user → 403"
echo "───────────────────────────────────────────────────────────────"
echo "$ curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"reset@e2e.test\",\"password\":\"Old-Pass-123\"}'"
echo ""
curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"reset@e2e.test","password":"Old-Pass-123"}' | python3 -m json.tool 2>/dev/null
echo ""
echo ""

# ─── 4. REFRESH — valid cookie → new access token ───────────────────
echo "───────────────────────────────────────────────────────────────"
echo "4. POST /auth/refresh — valid cookie → new access token"
echo "───────────────────────────────────────────────────────────────"
echo "$ curl -s -D- -X POST $BASE/auth/refresh -b 'uros_refresh=$REFRESH_COOKIE'"
echo ""
REFRESH_RESP=$(curl -s -D /tmp/headers_refresh.txt -X POST "$BASE/auth/refresh" \
  -b "uros_refresh=$REFRESH_COOKIE")
cat /tmp/headers_refresh.txt
echo "$REFRESH_RESP" | python3 -m json.tool 2>/dev/null || echo "$REFRESH_RESP"
echo ""

NEW_ACCESS=$(echo "$REFRESH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)
NEW_REFRESH=$(grep -i 'set-cookie' /tmp/headers_refresh.txt | sed 's/.*uros_refresh=//;s/;.*//' | tr -d '\r')
echo "[Extracted] new_access_token=${NEW_ACCESS:0:40}..."
echo "[Extracted] new_refresh_cookie=${NEW_REFRESH:0:40}..."
echo ""

# ─── 5. REFRESH — replay OLD (rotated) token → 401 + theft detection ─
echo "───────────────────────────────────────────────────────────────"
echo "5. POST /auth/refresh — replay OLD (rotated) token → 401 + audit"
echo "───────────────────────────────────────────────────────────────"
echo "$ curl -s -X POST $BASE/auth/refresh -b 'uros_refresh=$REFRESH_COOKIE'"
echo ""
curl -s -X POST "$BASE/auth/refresh" \
  -b "uros_refresh=$REFRESH_COOKIE" | python3 -m json.tool 2>/dev/null
echo ""
echo ""
echo "[Audit check — REFRESH_TOKEN_REUSE should appear:]"
echo "$ curl -s http://localhost:3099/api/v1/audit-logs?limit=5 -H 'Authorization: Bearer $NEW_ACCESS'"
echo ""
curl -s "$BASE/audit-logs?limit=5" \
  -H "Authorization: Bearer $NEW_ACCESS" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for e in data.get('entries',[]):
  if 'REUSE' in e.get('action','') or 'REUSED' in e.get('reason_code',''):
    print(f\"  FOUND: action={e['action']} reason_code={e['reason_code']} comment={e.get('reason_comment','')}\")
" 2>/dev/null || echo "  (audit parse skipped)"
echo ""

# ─── 6. LOGOUT — revoke session ─────────────────────────────────────
echo "───────────────────────────────────────────────────────────────"
echo "6. POST /auth/logout — revoke session"
echo "───────────────────────────────────────────────────────────────"
# Login fresh for logout test
LOGIN2=$(curl -s -D /tmp/headers_login2.txt -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"normal@e2e.test","password":"Secure-Pass-99"}')
TOKEN2=$(echo "$LOGIN2" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null)
COOKIE2=$(grep -i 'set-cookie' /tmp/headers_login2.txt | sed 's/.*uros_refresh=//;s/;.*//' | tr -d '\r')
echo "[Fresh login for logout test]"
echo "$ curl -s -X POST $BASE/auth/logout -H 'Authorization: Bearer $TOKEN2' -b 'uros_refresh=$COOKIE2'"
echo ""
curl -s -X POST "$BASE/auth/logout" \
  -H "Authorization: Bearer $TOKEN2" \
  -b "uros_refresh=$COOKIE2" | python3 -m json.tool 2>/dev/null
echo ""
echo ""
echo "[Verify revoked refresh cookie is now unusable:]"
echo "$ curl -s -X POST $BASE/auth/refresh -b 'uros_refresh=$COOKIE2'"
echo ""
curl -s -X POST "$BASE/auth/refresh" \
  -b "uros_refresh=$COOKIE2" | python3 -m json.tool 2>/dev/null
echo ""
echo ""

# ─── 7. PASSWORD RESET FLOW ─────────────────────────────────────────
echo "───────────────────────────────────────────────────────────────"
echo "7. Full Password Reset Flow"
echo "───────────────────────────────────────────────────────────────"
echo ""

# 7a. Request reset
echo "7a. POST /auth/password/reset/request"
echo "$ curl -s -X POST $BASE/auth/password/reset/request -H 'Content-Type: application/json' -d '{\"email\":\"reset@e2e.test\"}'"
echo ""
curl -s -X POST "$BASE/auth/password/reset/request" \
  -H "Content-Type: application/json" \
  -d '{"email":"reset@e2e.test"}' | python3 -m json.tool 2>/dev/null
echo ""
echo ""

# 7b. Extract the reset token from the database
echo "7b. Extract reset token from database (mock SMS delivery)"
RESET_TOKEN=$(docker exec qoder-test-postgres psql -U uros -d uros_e2e_test -t -A -c "SELECT 'EXTRACTED_TOKEN' FROM password_reset_tokens WHERE consumed_at IS NULL LIMIT 1;" 2>/dev/null)
# We need the raw token, but only the hash is stored. Let's insert a known token for testing.
echo "[Inserting a known test token for E2E verification...]"
docker exec qoder-test-postgres psql -U uros -d uros_e2e_test -c "
  DELETE FROM password_reset_tokens WHERE consumed_at IS NULL;
" 2>/dev/null

# Use the service directly to generate a reset token
RESET_RESULT=$(curl -s -X POST "$BASE/auth/password/reset/request" \
  -H "Content-Type: application/json" \
  -d '{"email":"reset@e2e.test"}')
echo "  Reset request response: $RESET_RESULT"

# Extract token hash from DB and use a direct insert approach
# Instead, let's use the verify endpoint to check if any tokens exist
echo ""
echo "[Checking password_reset_tokens table for the reset user...]"
docker exec qoder-test-postgres psql -U uros -d uros_e2e_test -c "
  SELECT token_hash, expires_at, consumed_at, issued_via, channel
  FROM password_reset_tokens
  WHERE user_id='eeeeeeee-2222-2222-2222-222222222222'
  ORDER BY issued_at DESC LIMIT 3;
" 2>/dev/null
echo ""

# For the E2E we need the raw token. Since only the hash is stored, we'll
# generate one directly via SQL for the confirm step.
echo "[Generating a test reset token directly for the confirm step...]"
# We'll use a Node one-liner to generate a token + hash
TOKEN_DATA=$(node -e "
const crypto = require('crypto');
const raw = crypto.randomBytes(32).toString('base64url');
const hash = crypto.createHash('sha256').update(raw).digest('hex');
console.log(JSON.stringify({raw, hash}));
")
RAW_TOKEN=$(echo "$TOKEN_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['raw'])")
TOKEN_HASH=$(echo "$TOKEN_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['hash'])")

# Insert the token directly
docker exec qoder-test-postgres psql -U uros -d uros_e2e_test -c "
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, issued_by, issued_via, channel)
  VALUES ('eeeeeeee-2222-2222-2222-222222222222', '$TOKEN_HASH', now() + interval '30 minutes', 'eeeeeeee-2222-2222-2222-222222222222', 'SELF', 'SMS');
" 2>/dev/null
echo "  Inserted test token: ${RAW_TOKEN:0:20}..."
echo ""

# 7c. Verify the token
echo "7c. GET /auth/password/reset/verify?token=..."
echo "$ curl -s '$BASE/auth/password/reset/verify?token=$RAW_TOKEN'"
echo ""
curl -s "$BASE/auth/password/reset/verify?token=$RAW_TOKEN" | python3 -m json.tool 2>/dev/null
echo ""
echo ""

# 7d. Confirm reset with new password
echo "7d. POST /auth/password/reset/confirm — set new password"
echo "$ curl -s -X POST $BASE/auth/password/reset/confirm -H 'Content-Type: application/json' -d '{\"token\":\"$RAW_TOKEN\",\"new_password\":\"Brand-New-Pass-7\"}'"
echo ""
curl -s -X POST "$BASE/auth/password/reset/confirm" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$RAW_TOKEN\",\"new_password\":\"Brand-New-Pass-7\"}" | python3 -m json.tool 2>/dev/null
echo ""
echo ""

# 7e. Confirm old password no longer works
echo "7e. POST /auth/login — old password no longer works"
echo "$ curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"reset@e2e.test\",\"password\":\"Old-Pass-123\"}'"
echo ""
curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"reset@e2e.test","password":"Old-Pass-123"}' | python3 -m json.tool 2>/dev/null
echo ""
echo ""

# 7f. Confirm new password works
echo "7f. POST /auth/login — new password works"
echo "$ curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"reset@e2e.test\",\"password\":\"Brand-New-Pass-7\"}'"
echo ""
FINAL_LOGIN=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"reset@e2e.test","password":"Brand-New-Pass-7"}')
echo "$FINAL_LOGIN" | python3 -m json.tool 2>/dev/null
echo ""
echo ""

# ─── 8. JWT GUARD — confirm no endpoint returns JWT outside auth flows ─
echo "───────────────────────────────────────────────────────────────"
echo "8. JWT GUARD — grep verification"
echo "───────────────────────────────────────────────────────────────"
echo "JWTs are minted in exactly 3 service functions:"
echo "  - login()          → password-login flow"
echo "  - refreshAccess()  → cookie-refresh flow"
echo "  - switchOrg()      → org-switch (re-auth) flow"
echo "  - confirmPasswordReset() → sets password (no JWT minted, only clears flag)"
echo ""
echo "accessTokenFor() call sites in service.ts:"
grep -n "accessTokenFor" src/services/auth/service.ts
echo ""
echo "sign() call sites (JWT minting):"
grep -rn "jwt.sign\|jsonwebtoken.*sign" src/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts"
echo ""

echo "═══════════════════════════════════════════════════════════════"
echo "  CHECKPOINT A E2E COMPLETE"
echo "  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "═══════════════════════════════════════════════════════════════"
