#!/usr/bin/env bash
# MetricFlock smoke test (monorepo step 3.8).
#
# Runs against a REAL Postgres + Redis (GitHub Actions services in CI, or a
# local docker-compose stack). Expects a production build already present
# (`pnpm build` first). Verifies, end to end:
#   1. migrate + seed work
#   2. demo admin can sign in
#   3. analytics for an unconnected website returns status "not_connected"
#      (no invented metrics)
#   4. one sync job can be queued via /api/sync
#   5. website transfer as a TEAM_MEMBER returns 403 (no website.transfer
#      permission) and as the super admin returns 200
#   6. security regressions (Stage 1): sign-up mass assignment rejected,
#      unverified sign-up cannot sign in, update-user role escalation
#      rejected, cross-org teamId rejected, foreign OAuth owner rejected,
#      legitimate same-org website create still works
#
# Env (CI sets these; locally export them or put them in apps/web/.env):
#   DATABASE_URL, REDIS_URL, SESSION_SECRET (or BETTER_AUTH_SECRET),
#   GOOGLE_TOKEN_ENCRYPTION_KEY, BASE_URL (default http://localhost:3000),
#   PORT (default 3000).
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PORT="${PORT:-3000}"
ADMIN_EMAIL="demo@example.com"
ADMIN_PASSWORD="ChangeMe123!"
MEMBER_EMAIL="member@example.com"
MEMBER_PASSWORD="SmokeMember123!"
ATTACKER_EMAIL="attacker-admin@example.com"
ATTACKER_PASSWORD="AttackerAdmin123!"

need() { command -v "$1" >/dev/null 2>&1 || { echo "smoke: missing required command: $1" >&2; exit 1; }; }
need curl
need node
need pnpm

TMP="$(mktemp -d)"
ADMIN_JAR="$TMP/admin.cookies"
MEMBER_JAR="$TMP/member.cookies"
ATTACKER_JAR="$TMP/attacker.cookies"
trap 'rm -rf "$TMP"; kill "$SERVER_PID" 2>/dev/null || true' EXIT

fail() { echo "smoke FAIL: $*" >&2; exit 1; }
ok() { echo "smoke ok: $*"; }

# better-auth rate-limits /sign-in and /sign-up to 3 requests per 10s per IP
# by default. This script fires several auth calls from localhost in quick
# succession, so retry on 429 (waiting out the window) instead of failing —
# the limiter doing its job must not be mistaken for a broken sign-in.
# Usage: auth_post OUTFILE JAR|- URL JSON   (prints the HTTP status code)
auth_post() {
  local out="$1" jar="$2" url="$3" data="$4" code attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if [ "$jar" = "-" ]; then
      code="$(curl -s -o "$out" -w "%{http_code}" -X POST "$url" -H "Content-Type: application/json" -d "$data")"
    else
      code="$(curl -s -o "$out" -w "%{http_code}" -c "$jar" -X POST "$url" -H "Content-Type: application/json" -d "$data")"
    fi
    [ "$code" != "429" ] && { echo "$code"; return 0; }
    sleep 4
  done
  echo "$code"
}


echo "smoke: migrate (deploy) + seed"
# `migrate deploy` (not `migrate dev`): applies the checked-in migrations
# without creating new ones — the right command for CI and servers.
DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec prisma migrate deploy >/dev/null || fail "prisma migrate deploy"
pnpm db:seed >/dev/null || fail "db:seed"
DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec tsx scripts/smoke-member.ts >/dev/null || fail "smoke-member setup"
DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec tsx scripts/smoke-attacker.ts >/dev/null || fail "smoke-attacker setup"

echo "smoke: starting web server on :$PORT"
PORT="$PORT" pnpm --filter @metricflock/web start >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

echo "smoke: waiting for readiness"
ready=0
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/login" || true)"
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" = "1" ] || { echo "--- server log ---"; tail -30 "$TMP/server.log"; fail "server did not become ready on $BASE_URL"; }
ok "server ready"

echo "smoke: admin sign-in"
code="$(auth_post "$TMP/signin.json" "$ADMIN_JAR" "$BASE_URL/api/auth/sign-in/email" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
[ "$code" = "200" ] || { cat "$TMP/signin.json"; fail "admin sign-in returned $code"; }
grep -q "better-auth.session_token" "$ADMIN_JAR" || fail "no session cookie after admin sign-in"
ok "admin signed in"

TEAM_B_ID="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/api/teams" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const t=d.teams.find((x)=>x.slug==="team-b");if(!t){console.error("team-b not found");process.exit(1)}console.log(t.id)')"
[ -n "$TEAM_B_ID" ] || fail "team-b not found"
# Pick a website that is NOT already in the destination team (the API returns
# newest first, and the seed puts the newest websites in team-b — transferring
# one of those would correctly fail with already_in_team).
WEBSITE_ID="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/api/websites" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const w=d.websites.find((x)=>x.teamId!==process.argv[1]);if(!w){console.error("no website outside destination team");process.exit(1)}console.log(w.id)' "$TEAM_B_ID")"
[ -n "$WEBSITE_ID" ] || fail "no website outside destination team"
ok "website $WEBSITE_ID, destination team $TEAM_B_ID"

echo "smoke: analytics returns not_connected for unconnected website"
body="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/api/analytics/overview?websiteId=$WEBSITE_ID")"
echo "$body" | grep -q '"status":"not_connected"' || { echo "$body"; fail "expected status not_connected"; }
ok "analytics not_connected"

echo "smoke: queue one sync job"
code="$(curl -s -o "$TMP/sync.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/sync" -H "Content-Type: application/json" -d "{\"websiteId\":\"$WEBSITE_ID\",\"type\":\"integration-health-check\"}")"
[ "$code" = "200" ] || { cat "$TMP/sync.json"; fail "sync returned $code"; }
grep -q '"status":"ok"' "$TMP/sync.json" || { cat "$TMP/sync.json"; fail "sync did not return status ok"; }
ok "sync job queued (or recorded)"

echo "smoke: member sign-in + transfer must be 403"
code="$(auth_post "$TMP/member-signin.json" "$MEMBER_JAR" "$BASE_URL/api/auth/sign-in/email" "{\"email\":\"$MEMBER_EMAIL\",\"password\":\"$MEMBER_PASSWORD\"}")"
[ "$code" = "200" ] || fail "member sign-in returned $code"
code="$(curl -s -o "$TMP/t403.json" -w "%{http_code}" -b "$MEMBER_JAR" -X POST "$BASE_URL/api/websites/$WEBSITE_ID/transfer" -H "Content-Type: application/json" -d "{\"toTeamId\":\"$TEAM_B_ID\",\"reason\":\"smoke test\"}")"
[ "$code" = "403" ] || { cat "$TMP/t403.json"; fail "member transfer returned $code, expected 403"; }
ok "member transfer correctly forbidden (403)"

echo "smoke: admin transfer succeeds"
code="$(curl -s -o "$TMP/t200.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/websites/$WEBSITE_ID/transfer" -H "Content-Type: application/json" -d "{\"toTeamId\":\"$TEAM_B_ID\",\"reason\":\"smoke test\"}")"
[ "$code" = "200" ] || { cat "$TMP/t200.json"; fail "admin transfer returned $code"; }
ok "admin transfer succeeded"

echo "smoke: security — sign-up mass assignment is rejected"
# role/organizationId must never be client-settable (audit AUTH-1).
code="$(auth_post "$TMP/ma.json" - "$BASE_URL/api/auth/sign-up/email" "{\"name\":\"Attacker\",\"email\":\"mass-assign-$$@example.com\",\"password\":\"MassAssign123!\",\"role\":\"SUPER_ADMIN\",\"organizationId\":\"foreign-org-id\"}")"
[ "$code" = "400" ] || { cat "$TMP/ma.json"; fail "sign-up with role/organizationId returned $code, expected 400"; }
ok "sign-up mass assignment rejected ($code)"

echo "smoke: security — unverified sign-up cannot sign in"
code="$(auth_post "$TMP/su.json" - "$BASE_URL/api/auth/sign-up/email" "{\"name\":\"New User\",\"email\":\"unverified-$$@example.com\",\"password\":\"Unverified123!\"}")"
[ "$code" = "200" ] || { cat "$TMP/su.json"; fail "plain sign-up returned $code"; }
code="$(auth_post "$TMP/si.json" - "$BASE_URL/api/auth/sign-in/email" "{\"email\":\"unverified-$$@example.com\",\"password\":\"Unverified123!\"}")"
# Must be the email-verification block (403), not a rate limit (auth_post
# already retried past any 429) and never a successful sign-in.
[ "$code" = "403" ] || { cat "$TMP/si.json"; fail "unverified sign-in returned $code, expected 403"; }
ok "unverified sign-in blocked ($code)"

echo "smoke: security — update-user role escalation is rejected"
# audit AUTH-2: a TEAM_MEMBER must not be able to set their own role.
code="$(curl -s -o "$TMP/uu.json" -w "%{http_code}" -b "$MEMBER_JAR" -X POST "$BASE_URL/api/auth/update-user" -H "Content-Type: application/json" -d '{"role":"SUPER_ADMIN"}')"
[ "$code" != "200" ] || { cat "$TMP/uu.json"; fail "update-user accepted role escalation"; }
code="$(curl -s -o "$TMP/t403b.json" -w "%{http_code}" -b "$MEMBER_JAR" -X POST "$BASE_URL/api/websites/$WEBSITE_ID/transfer" -H "Content-Type: application/json" -d "{\"toTeamId\":\"$TEAM_B_ID\",\"reason\":\"smoke test\"}")"
[ "$code" = "403" ] || { cat "$TMP/t403b.json"; fail "member transfer after escalation attempt returned $code, expected 403"; }
ok "role escalation rejected, member still 403"

echo "smoke: security — cross-org teamId and foreign OAuth owner are rejected"
code="$(auth_post "$TMP/attacker-signin.json" "$ATTACKER_JAR" "$BASE_URL/api/auth/sign-in/email" "{\"email\":\"$ATTACKER_EMAIL\",\"password\":\"$ATTACKER_PASSWORD\"}")"
[ "$code" = "200" ] || fail "attacker-admin sign-in returned $code"
# audit API-1: attacker-org admin must not attach a website to main-org's team.
code="$(curl -s -o "$TMP/xorg.json" -w "%{http_code}" -b "$ATTACKER_JAR" -X POST "$BASE_URL/api/websites" -H "Content-Type: application/json" -d "{\"name\":\"Evil\",\"domain\":\"evil-$$.example.com\",\"url\":\"https://evil.example.com\",\"teamId\":\"$TEAM_B_ID\"}")"
[ "$code" = "404" ] || { cat "$TMP/xorg.json"; fail "cross-org teamId returned $code, expected 404"; }
# audit OAUTH-6: attacker-org admin must not start OAuth for main-org's team.
code="$(curl -s -o "$TMP/xoauth.json" -w "%{http_code}" -b "$ATTACKER_JAR" "$BASE_URL/api/google/oauth/connect?ownerType=TEAM&ownerId=$TEAM_B_ID")"
[ "$code" = "404" ] || { cat "$TMP/xoauth.json"; fail "foreign OAuth owner returned $code, expected 404"; }
# attacker-org sees none of main-org's websites.
count="$(curl -s -b "$ATTACKER_JAR" "$BASE_URL/api/websites" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.websites.length)')"
[ "$count" = "0" ] || fail "attacker-org sees $count websites, expected 0"
ok "cross-tenant attacks rejected"

echo "smoke: legitimate same-org website create still works"
code="$(curl -s -o "$TMP/legit.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/websites" -H "Content-Type: application/json" -d "{\"name\":\"Legit Site\",\"domain\":\"legit-$$.example.com\",\"url\":\"https://legit.example.com\",\"teamId\":\"$TEAM_B_ID\"}")"
[ "$code" = "201" ] || { cat "$TMP/legit.json"; fail "same-org website create returned $code"; }
ok "same-org website create works"

echo "smoke: ALL CHECKS PASSED"
