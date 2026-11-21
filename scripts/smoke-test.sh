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
TEAMADMIN_EMAIL="teamadmin@example.com"
TEAMADMIN_PASSWORD="TeamAdmin123!"
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
TEAMADMIN_JAR="$TMP/teamadmin.cookies"
SERVER_PID=""
trap 'rm -rf "$TMP"; [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true' EXIT

fail() { echo "smoke FAIL: $*" >&2; exit 1; }
ok() { echo "smoke ok: $*"; }

# better-auth rate-limits /sign-in and /sign-up to 3 requests per 10s per IP
# by default. This script fires several auth calls from localhost in quick
# succession, so retry on 429 (waiting out the window) instead of failing —
# the limiter doing its job must not be mistaken for a broken sign-in.
# Usage: auth_post OUTFILE JAR|- URL JSON   (prints the HTTP status code)
# The jar is both read (-b) and written (-c): sign-in only needs the
# write, but authenticated auth calls (two-factor enable/verify, sign-out)
# must also SEND the session cookie. The Origin header mimics a browser
# same-origin POST — better-auth runs its CSRF origin check whenever a
# cookie header is present and rejects cookie-bearing requests without
# one (403 MISSING_OR_NULL_ORIGIN).
auth_post() {
  local out="$1" jar="$2" url="$3" data="$4" code attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    if [ "$jar" = "-" ]; then
      code="$(curl -s -o "$out" -w "%{http_code}" -X POST "$url" -H "Content-Type: application/json" -H "Origin: $BASE_URL" -d "$data")"
    else
      code="$(curl -s -o "$out" -w "%{http_code}" -b "$jar" -c "$jar" -X POST "$url" -H "Content-Type: application/json" -H "Origin: $BASE_URL" -d "$data")"
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
# NOTE: the Stage 2 fixture (smoke-stage2.ts) runs later, just before the
# Stage 2 checks — it creates GoogleConnection rows for team-a/team-b,
# which would change the earlier "analytics returns not_connected" check
# (with a team connection present, the correct status is missing_data).

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
code="$(curl -s -o "$TMP/uu.json" -w "%{http_code}" -b "$MEMBER_JAR" -X POST "$BASE_URL/api/auth/update-user" -H "Content-Type: application/json" -H "Origin: $BASE_URL" -d '{"role":"SUPER_ADMIN"}')"
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

echo "smoke: stage2 fixture (team admin + connections + discovered properties)"
STAGE2_IDS="$(DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec tsx scripts/smoke-stage2.ts)" || fail "smoke-stage2 setup"
ADMIN_USER_ID="$(echo "$STAGE2_IDS" | grep '^ADMIN_USER_ID=' | cut -d= -f2)"
TEAMADMIN_USER_ID="$(echo "$STAGE2_IDS" | grep '^TEAMADMIN_USER_ID=' | cut -d= -f2)"
CONN_A_ID="$(echo "$STAGE2_IDS" | grep '^CONN_A_ID=' | cut -d= -f2)"
CONN_B_ID="$(echo "$STAGE2_IDS" | grep '^CONN_B_ID=' | cut -d= -f2)"
[ -n "$ADMIN_USER_ID" ] && [ -n "$TEAMADMIN_USER_ID" ] && [ -n "$CONN_A_ID" ] && [ -n "$CONN_B_ID" ] || fail "stage2 fixture ids missing"

echo "smoke: stage2 — mapping rejects undiscovered properties, persists FKs"
code="$(curl -s -o "$TMP/map400.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/google/properties/map" -H "Content-Type: application/json" -d "{\"websiteId\":\"$WEBSITE_ID\",\"provider\":\"GA4\",\"externalId\":\"properties/999999999\"}")"
[ "$code" = "400" ] || { cat "$TMP/map400.json"; fail "undiscovered mapping returned $code, expected 400"; }
grep -q '"property_not_discovered"' "$TMP/map400.json" || { cat "$TMP/map400.json"; fail "expected property_not_discovered"; }
code="$(curl -s -o "$TMP/map1.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/google/properties/map" -H "Content-Type: application/json" -d "{\"websiteId\":\"$WEBSITE_ID\",\"provider\":\"GA4\",\"externalId\":\"properties/123456789\",\"isPrimary\":true}")"
[ "$code" = "200" ] || { cat "$TMP/map1.json"; fail "discovered mapping returned $code"; }
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const i=d.integration;if(i.googleConnectionId!==process.argv[2]){console.error("googleConnectionId mismatch",i);process.exit(1)}if(!i.googlePropertyId){console.error("googlePropertyId not persisted",i);process.exit(1)}' "$TMP/map1.json" "$CONN_A_ID" || fail "mapping FKs not persisted"
ok "mapping verifies discovery and persists connection/property FKs"

echo "smoke: stage2 — single primary per (website, provider)"
code="$(curl -s -o "$TMP/map2.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/google/properties/map" -H "Content-Type: application/json" -d "{\"websiteId\":\"$WEBSITE_ID\",\"provider\":\"GA4\",\"externalId\":\"properties/987654321\",\"isPrimary\":true}")"
[ "$code" = "200" ] || { cat "$TMP/map2.json"; fail "second primary mapping returned $code"; }
curl -s -b "$ADMIN_JAR" "$BASE_URL/api/websites/$WEBSITE_ID" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=d.website.integrations.filter((i)=>i.provider==="GA4"&&i.isPrimary);if(p.length!==1||p[0].externalId!=="properties/987654321"){console.error("expected exactly one primary (987654321), got",JSON.stringify(p));process.exit(1)}' || fail "single-primary rule violated"
ok "exactly one primary integration"

echo "smoke: stage2 — server-managed website status rejected"
code="$(curl -s -o "$TMP/sold.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/websites" -H "Content-Type: application/json" -d "{\"name\":\"Sold Site\",\"domain\":\"sold-$$.example.com\",\"url\":\"https://sold.example.com\",\"status\":\"SOLD\"}")"
[ "$code" = "400" ] || { cat "$TMP/sold.json"; fail "status SOLD returned $code, expected 400"; }
ok "status SOLD rejected"

echo "smoke: stage2 — last team admin cannot be removed or demoted"
GUARD_TEAM_ID="$(curl -s -b "$ADMIN_JAR" -X POST "$BASE_URL/api/teams" -H "Content-Type: application/json" -d "{\"name\":\"Smoke Guard Team\",\"slug\":\"smoke-guard-$$\"}" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.team.id)')"
[ -n "$GUARD_TEAM_ID" ] || fail "guard team create failed"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/teams/$GUARD_TEAM_ID/members" -H "Content-Type: application/json" -d "{\"userId\":\"$TEAMADMIN_USER_ID\",\"isAdmin\":true,\"action\":\"add\"}")"
[ "$code" = "200" ] || fail "add guard admin returned $code"
code="$(curl -s -o "$TMP/lastadmin.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/teams/$GUARD_TEAM_ID/members" -H "Content-Type: application/json" -d "{\"userId\":\"$TEAMADMIN_USER_ID\",\"action\":\"remove\"}")"
[ "$code" = "409" ] || { cat "$TMP/lastadmin.json"; fail "remove last admin returned $code, expected 409"; }
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/teams/$GUARD_TEAM_ID/members" -H "Content-Type: application/json" -d "{\"userId\":\"$ADMIN_USER_ID\",\"isAdmin\":true,\"action\":\"add\"}")"
[ "$code" = "200" ] || fail "add second guard admin returned $code"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/teams/$GUARD_TEAM_ID/members" -H "Content-Type: application/json" -d "{\"userId\":\"$TEAMADMIN_USER_ID\",\"action\":\"remove\"}")"
[ "$code" = "200" ] || fail "remove non-last admin returned $code"
ok "last-admin guard works"

echo "smoke: stage2 — connection visibility is team-scoped"
code="$(auth_post "$TMP/teamadmin-signin.json" "$TEAMADMIN_JAR" "$BASE_URL/api/auth/sign-in/email" "{\"email\":\"$TEAMADMIN_EMAIL\",\"password\":\"$TEAMADMIN_PASSWORD\"}")"
[ "$code" = "200" ] || fail "teamadmin sign-in returned $code"
curl -s -b "$TEAMADMIN_JAR" "$BASE_URL/api/google/connections" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const emails=d.connections.map((c)=>c.googleAccountEmail);if(!emails.includes("ga-a@example.com")){console.error("teamadmin should see ga-a",emails);process.exit(1)}if(emails.includes("ga-b@example.com")){console.error("teamadmin must not see ga-b",emails);process.exit(1)}' || fail "connection visibility wrong for teamadmin"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$TEAMADMIN_JAR" -X POST "$BASE_URL/api/google/connections/disconnect" -H "Content-Type: application/json" -d "{\"connectionId\":\"$CONN_B_ID\"}")"
[ "$code" = "404" ] || fail "disconnect foreign-team connection returned $code, expected 404"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$TEAMADMIN_JAR" -X POST "$BASE_URL/api/google/properties/discover" -H "Content-Type: application/json" -d "{\"connectionId\":\"$CONN_B_ID\"}")"
[ "$code" = "404" ] || fail "discover foreign-team connection returned $code, expected 404"
curl -s -b "$ADMIN_JAR" "$BASE_URL/api/google/connections" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const emails=d.connections.map((c)=>c.googleAccountEmail);if(!emails.includes("ga-a@example.com")||!emails.includes("ga-b@example.com")){console.error("super admin should see both",emails);process.exit(1)}' || fail "super admin connection visibility wrong"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$TEAMADMIN_JAR" -X POST "$BASE_URL/api/google/connections/disconnect" -H "Content-Type: application/json" -d "{\"connectionId\":\"$CONN_A_ID\"}")"
[ "$code" = "200" ] || fail "disconnect own-team connection returned $code"
ok "connection visibility scoped; own-team disconnect works"

echo "smoke: stage3 oauth fixture (expired + wrong-session states)"
OAUTH_IDS="$(DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec tsx scripts/smoke-oauth-state.ts)" || fail "smoke-oauth-state setup"
EXPIRED_STATE="$(echo "$OAUTH_IDS" | grep '^EXPIRED_STATE=' | cut -d= -f2-)"
MEMBER_STATE="$(echo "$OAUTH_IDS" | grep '^MEMBER_STATE=' | cut -d= -f2-)"
[ -n "$EXPIRED_STATE" ] && [ -n "$MEMBER_STATE" ] || fail "oauth fixture states missing"
TEAM_A_ID="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/api/teams" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const t=d.teams.find((x)=>x.slug==="team-a");if(!t){console.error("team-a not found");process.exit(1)}console.log(t.id)')"
[ -n "$TEAM_A_ID" ] || fail "team-a not found"

echo "smoke: stage3 — forged and expired states are rejected"
loc="$(curl -s -o /dev/null -w "%{redirect_url}" "$BASE_URL/api/google/oauth/callback?code=fake&state=garbage")"
case "$loc" in *oauth=bad_state*) ;; *) fail "forged state redirect was $loc" ;; esac
loc="$(curl -s -o /dev/null -w "%{redirect_url}" -b "$ADMIN_JAR" "$BASE_URL/api/google/oauth/callback?code=fake&state=$EXPIRED_STATE")"
case "$loc" in *oauth=bad_state*) ;; *) fail "expired state redirect was $loc" ;; esac
ok "forged + expired states rejected"

echo "smoke: stage3 — wrong-session state is rejected"
loc="$(curl -s -o /dev/null -w "%{redirect_url}" -b "$ADMIN_JAR" "$BASE_URL/api/google/oauth/callback?code=fake&state=$MEMBER_STATE")"
case "$loc" in *oauth=session_mismatch*) ;; *) fail "wrong-session redirect was $loc" ;; esac
ok "wrong-session rejected"

echo "smoke: stage3 — connect issues PKCE + single-use state; replay rejected"
CONNECT_JSON="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/api/google/oauth/connect?ownerType=TEAM&ownerId=$TEAM_A_ID")"
STATE1="$(echo "$CONNECT_JSON" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const u=new URL(d.authUrl);if(!u.searchParams.get("code_challenge")){console.error("no code_challenge in authUrl");process.exit(1)}console.log(u.searchParams.get("state"))')" || fail "connect authUrl missing PKCE/state"
[ -n "$STATE1" ] || fail "connect returned no state"
loc="$(curl -s -o /dev/null -w "%{redirect_url}" "$BASE_URL/api/google/oauth/callback?code=fake&state=$STATE1")"
case "$loc" in *oauth=login_required*) ;; *) fail "no-session redirect was $loc" ;; esac
CONNECT_JSON="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/api/google/oauth/connect?ownerType=TEAM&ownerId=$TEAM_A_ID")"
STATE2="$(echo "$CONNECT_JSON" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(new URL(d.authUrl).searchParams.get("state"))')"
[ -n "$STATE2" ] || fail "second connect returned no state"
loc="$(curl -s -o /dev/null -w "%{redirect_url}" -b "$ADMIN_JAR" "$BASE_URL/api/google/oauth/callback?code=fake-code&state=$STATE2")"
case "$loc" in *oauth=failed*) ;; *) fail "first callback redirect was $loc (expected failed: fake code)" ;; esac
loc="$(curl -s -o /dev/null -w "%{redirect_url}" -b "$ADMIN_JAR" "$BASE_URL/api/google/oauth/callback?code=fake-code&state=$STATE2")"
case "$loc" in *oauth=bad_state*) ;; *) fail "replay redirect was $loc (expected bad_state)" ;; esac
ok "PKCE present; state single-use; replay rejected"

echo "smoke: stage5 — list pagination is bounded and reported"
PAGE_JSON="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/api/websites?limit=1&offset=0")"
echo "$PAGE_JSON" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));if(!Array.isArray(d.websites)||d.websites.length>1)process.exit(1);if(typeof d.pagination?.total!=="number"||d.pagination.limit!==1)process.exit(1)' || fail "pagination shape wrong: $PAGE_JSON"
ok "pagination bounded + total reported"

echo "smoke: stage6 — security headers + login labels"
HEADERS="$(curl -sI "$BASE_URL/login")"
for h in "x-content-type-options: nosniff" "x-frame-options: DENY" "content-security-policy:" "referrer-policy:"; do
  echo "$HEADERS" | grep -qi "^$h" || fail "missing security header: $h"
done
curl -s "$BASE_URL/login" | grep -q 'for="login-email"' || fail "login email label missing"
curl -s "$BASE_URL/login" | grep -q 'for="login-password"' || fail "login password label missing"
ok "security headers present; login inputs labeled"

echo "smoke: stage7 — password reset end-to-end (attacker account)"
curl -s "$BASE_URL/forgot-password" | grep -q 'for="forgot-email"' || fail "forgot-password label missing"
NEW_ATTACKER_PASSWORD="${ATTACKER_PASSWORD}New9"
code="$(auth_post "$TMP/reset-req.json" "-" "$BASE_URL/api/auth/request-password-reset" "{\"email\":\"$ATTACKER_EMAIL\",\"redirectTo\":\"/reset-password\"}")"
[ "$code" = "200" ] || fail "request-password-reset returned $code"
RESET_OUT="$(DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec tsx scripts/smoke-reset-token.ts "$ATTACKER_EMAIL")" || fail "reset token fixture"
RESET_TOKEN="$(echo "$RESET_OUT" | sed -n 's/^RESET_TOKEN=//p')"
[ -n "$RESET_TOKEN" ] || fail "no reset token"
code="$(auth_post "$TMP/reset-do.json" "-" "$BASE_URL/api/auth/reset-password" "{\"newPassword\":\"$NEW_ATTACKER_PASSWORD\",\"token\":\"$RESET_TOKEN\"}")"
[ "$code" = "200" ] || { cat "$TMP/reset-do.json"; fail "reset-password returned $code"; }
# Sessions revoked on reset: the pre-reset attacker cookie must now fail.
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" "$BASE_URL/api/websites")"
[ "$code" = "401" ] || fail "old session still valid after reset (got $code)"
code="$(auth_post "$TMP/old-pw.json" "-" "$BASE_URL/api/auth/sign-in/email" "{\"email\":\"$ATTACKER_EMAIL\",\"password\":\"$ATTACKER_PASSWORD\"}")"
[ "$code" = "401" ] || fail "old password still works after reset (got $code)"
code="$(auth_post "$TMP/new-pw.json" "$ATTACKER_JAR" "$BASE_URL/api/auth/sign-in/email" "{\"email\":\"$ATTACKER_EMAIL\",\"password\":\"$NEW_ATTACKER_PASSWORD\"}")"
[ "$code" = "200" ] || fail "new password sign-in returned $code"
ok "password reset works; sessions revoked; old password dead"

echo "smoke: stage7 — TOTP two-factor end-to-end"
code="$(auth_post "$TMP/2fa-enable.json" "$ATTACKER_JAR" "$BASE_URL/api/auth/two-factor/enable" "{\"password\":\"$NEW_ATTACKER_PASSWORD\"}")"
[ "$code" = "200" ] || { cat "$TMP/2fa-enable.json"; fail "two-factor enable returned $code"; }
TOTP_SECRET="$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=/secret=([A-Z2-7]+)/i.exec(d.totpURI||"");console.log(m?m[1]:"")' "$TMP/2fa-enable.json")"
[ -n "$TOTP_SECRET" ] || fail "no TOTP secret in enable response"
TOTP_CODE="$(DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec tsx scripts/smoke-totp.ts "$TOTP_SECRET")"
code="$(auth_post "$TMP/2fa-verify.json" "$ATTACKER_JAR" "$BASE_URL/api/auth/two-factor/verify-totp" "{\"code\":\"$TOTP_CODE\"}")"
[ "$code" = "200" ] || { cat "$TMP/2fa-verify.json"; fail "two-factor verify returned $code"; }
# Sign out, then sign in through the app wrapper: must demand the 2FA code.
auth_post "$TMP/signout.json" "$ATTACKER_JAR" "$BASE_URL/api/auth/sign-out" "{}" >/dev/null || true
sleep 32 # next TOTP window — the setup code must not be replayed
code="$(auth_post "$TMP/2fa-login.json" "$ATTACKER_JAR" "$BASE_URL/api/auth/login" "{\"email\":\"$ATTACKER_EMAIL\",\"password\":\"$NEW_ATTACKER_PASSWORD\"}")"
[ "$code" = "200" ] || fail "2FA login returned $code"
grep -q "two_factor_required" "$TMP/2fa-login.json" || { cat "$TMP/2fa-login.json"; fail "login did not demand two-factor code"; }
TOTP_CODE2="$(DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec tsx scripts/smoke-totp.ts "$TOTP_SECRET")"
code="$(auth_post "$TMP/2fa-login-verify.json" "$ATTACKER_JAR" "$BASE_URL/api/auth/two-factor/verify-totp" "{\"code\":\"$TOTP_CODE2\"}")"
[ "$code" = "200" ] || { cat "$TMP/2fa-login-verify.json"; fail "2FA login verify returned $code"; }
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" "$BASE_URL/api/websites")"
[ "$code" = "200" ] || fail "session after 2FA verify returned $code"
ok "TOTP 2FA: enable, verify, sign-in challenge all work"

echo "smoke: stage7 — two-sided transfer lifecycle"
TRANSFER_ID="$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.transfer?.id??"")' "$TMP/t200.json")"
[ -n "$TRANSFER_ID" ] || fail "no transfer id from initiate"
grep -q "PENDING_ACCEPTANCE" "$TMP/t200.json" || fail "initiate did not land in PENDING_ACCEPTANCE"
# Duplicate open transfer for the same website is rejected.
code="$(curl -s -o "$TMP/tdup.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/websites/$WEBSITE_ID/transfer" -H "Content-Type: application/json" -d "{\"toTeamId\":\"$TEAM_B_ID\"}")"
[ "$code" = "409" ] || { cat "$TMP/tdup.json"; fail "duplicate transfer returned $code, expected 409"; }
# A non-admin member cannot accept for the destination team.
code="$(curl -s -o "$TMP/tacc403.json" -w "%{http_code}" -b "$MEMBER_JAR" -X POST "$BASE_URL/api/transfers/$TRANSFER_ID/accept")"
[ "$code" = "403" ] || { cat "$TMP/tacc403.json"; fail "member accept returned $code, expected 403"; }
# Website must NOT have moved yet.
team_now="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/api/websites?limit=200" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const w=d.websites.find((x)=>x.id===process.argv[1]);console.log(w?.teamId??"")' "$WEBSITE_ID")"
[ "$team_now" != "$TEAM_B_ID" ] || fail "website moved before acceptance"
code="$(curl -s -o "$TMP/tacc.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/transfers/$TRANSFER_ID/accept")"
[ "$code" = "200" ] || { cat "$TMP/tacc.json"; fail "accept returned $code"; }
grep -q "PENDING_CONNECTION" "$TMP/tacc.json" || fail "accept did not land in PENDING_CONNECTION"
# Stage-2 fixture gave team-b an ACTIVE connection, so completion succeeds.
code="$(curl -s -o "$TMP/tcomp.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/transfers/$TRANSFER_ID/complete")"
[ "$code" = "200" ] || { cat "$TMP/tcomp.json"; fail "complete returned $code"; }
grep -q "COMPLETED" "$TMP/tcomp.json" || fail "complete did not land in COMPLETED"
team_now="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/api/websites?limit=200" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const w=d.websites.find((x)=>x.id===process.argv[1]);console.log(w?.teamId??"")' "$WEBSITE_ID")"
[ "$team_now" = "$TEAM_B_ID" ] || fail "website did not move to destination team at completion"
code="$(curl -s -o "$TMP/tcomp2.json" -w "%{http_code}" -b "$ADMIN_JAR" -X POST "$BASE_URL/api/transfers/$TRANSFER_ID/complete")"
[ "$code" = "409" ] || fail "second complete returned $code, expected 409"
ok "two-sided transfer: initiate, duplicate 409, accept, complete, team moved only at completion"

echo "smoke: stage7 — security page + audit coverage"
curl -s -b "$ADMIN_JAR" "$BASE_URL/settings/security" | grep -q "Active sessions" || fail "security page missing sessions"
AUDIT_OUT="$(DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec tsx scripts/smoke-audit-check.ts)" || fail "audit fixture"
SIGNINS="$(echo "$AUDIT_OUT" | sed -n 's/.*AUTH_SIGNIN_COUNT=\([0-9]*\).*/\1/p')"
WITHIP="$(echo "$AUDIT_OUT" | sed -n 's/.*AUDIT_WITH_IP=\([0-9]*\).*/\1/p')"
[ "${SIGNINS:-0}" -ge 1 ] || fail "no auth.sign_in audit rows ($AUDIT_OUT)"
[ "${WITHIP:-0}" -ge 1 ] || fail "no audit rows with ipAddress ($AUDIT_OUT)"
ok "security page renders; auth events + IPs in audit log"

echo "smoke: stage8 — health, metrics, correlation ids, DLQ requeue"
# Liveness + readiness are public and must report the real deps.
code="$(curl -s -o "$TMP/health.json" -w "%{http_code}" "$BASE_URL/api/health")"
[ "$code" = "200" ] || fail "/api/health returned $code"
grep -q '"status":"ok"' "$TMP/health.json" || fail "/api/health body unexpected"
# Correlation id: middleware stamps x-request-id on every response.
curl -sI "$BASE_URL/api/health" | grep -qi "^x-request-id:" || fail "x-request-id header missing"
code="$(curl -s -o "$TMP/ready.json" -w "%{http_code}" "$BASE_URL/api/health/ready")"
[ "$code" = "200" ] || { cat "$TMP/ready.json"; fail "/api/health/ready returned $code"; }
grep -q '"db":"ok"' "$TMP/ready.json" || fail "readiness db check not ok"
grep -q '"redis":"ok"' "$TMP/ready.json" || fail "readiness redis check not ok"
# Metrics are SUPER_ADMIN-only.
code="$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/metrics")"
[ "$code" = "401" ] || fail "anonymous /api/metrics returned $code, expected 401"
code="$(curl -s -o "$TMP/metrics.json" -w "%{http_code}" -b "$ADMIN_JAR" "$BASE_URL/api/metrics")"
[ "$code" = "200" ] || { cat "$TMP/metrics.json"; fail "admin /api/metrics returned $code"; }
grep -q '"sync24h"' "$TMP/metrics.json" || fail "metrics missing sync24h"
grep -q '"queues"' "$TMP/metrics.json" || fail "metrics missing queues"
# DLQ: fixture a FAILED row, list it, requeue it, confirm it leaves the DLQ.
FAILED_OUT="$(DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter @metricflock/db exec tsx scripts/smoke-failed-job.ts)" || fail "failed-job fixture"
FAILED_JOB_ID="$(echo "$FAILED_OUT" | sed -n 's/.*FAILED_JOB_ID=\([A-Za-z0-9_-]*\).*/\1/p')"
[ -n "$FAILED_JOB_ID" ] || fail "failed-job fixture printed no id ($FAILED_OUT)"
curl -s -b "$ADMIN_JAR" "$BASE_URL/api/sync/failed" | grep -q "$FAILED_JOB_ID" || fail "DLQ list missing fixture job"
code="$(curl -s -o "$TMP/requeue.json" -w "%{http_code}" -b "$ADMIN_JAR" -H "Content-Type: application/json" -X POST "$BASE_URL/api/sync/requeue" -d "{\"jobId\":\"$FAILED_JOB_ID\"}")"
[ "$code" = "200" ] || { cat "$TMP/requeue.json"; fail "requeue returned $code"; }
curl -s -b "$ADMIN_JAR" "$BASE_URL/api/sync/failed" | grep -q "$FAILED_JOB_ID" && fail "requeued job still in DLQ"
# Member cannot requeue.
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$MEMBER_JAR" -H "Content-Type: application/json" -X POST "$BASE_URL/api/sync/requeue" -d "{\"jobId\":\"$FAILED_JOB_ID\"}")"
[ "$code" = "403" ] || fail "member requeue returned $code, expected 403"
ok "health + readiness ok; metrics gated; DLQ list + requeue work"

echo "smoke: stage8 — backup/restore drill"
# Real pg_dump -> pg_restore into a scratch DB -> row checks -> drop.
# Proves docs/operations/backup-restore.md against the current schema.
if ! command -v pg_dump >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client >/dev/null 2>&1 || fail "postgresql-client install failed"
fi
BACKUP_FILE="$TMP/mf-backup.dump"
pg_dump "$DATABASE_URL" -Fc -f "$BACKUP_FILE" || fail "pg_dump failed"
ADMIN_URL="$(echo "$DATABASE_URL" | sed 's|/metricflock_test|/postgres|')"
SCRATCH_URL="$(echo "$DATABASE_URL" | sed 's|/metricflock_test|/metricflock_restore_test|')"
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS metricflock_restore_test" || fail "scratch drop failed"
psql "$ADMIN_URL" -q -c "CREATE DATABASE metricflock_restore_test" || fail "scratch create failed"
# Restore via SQL pipe: the runner's pg_dump (17+) emits
# `SET transaction_timeout = 0;` which a PG16 server rejects, making
# pg_restore exit 1 even though the restore itself succeeds. Filtering
# that one GUC and restoring through psql with ON_ERROR_STOP keeps the
# drill strict about real errors. (scripts/restore.sh stays a plain
# pg_restore — operators should use a client matching their server.)
pg_restore -f - "$BACKUP_FILE" | grep -v '^SET transaction_timeout' | psql "$SCRATCH_URL" -q -v ON_ERROR_STOP=1 || fail "pg_restore failed"
USER_COUNT="$(psql "$SCRATCH_URL" -tA -c 'SELECT count(*) FROM "User"')" || fail "restored user count query failed"
[ "${USER_COUNT:-0}" -ge 1 ] || fail "restored DB has no users"
MIG_COUNT="$(psql "$SCRATCH_URL" -tA -c 'SELECT count(*) FROM "_prisma_migrations"')" || fail "restored migrations query failed"
[ "${MIG_COUNT:-0}" -ge 1 ] || fail "restored DB has no migration rows"
psql "$ADMIN_URL" -q -c "DROP DATABASE metricflock_restore_test" || fail "scratch cleanup failed"
ok "backup/restore drill: dump restored, users + migrations intact"

echo "smoke: stage9 — cross-tenant IDOR matrix (attacker org vs demo org)"
# Every demo-org resource must be invisible (404) to the attacker org's
# SUPER_ADMIN — the strongest cross-tenant probe. Route-level authz is
# exercised against the real DB here, not mocked (CI-6).
expect404() { # label code
  [ "$2" = "404" ] || fail "IDOR: $1 returned $2, expected 404"
}
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" "$BASE_URL/api/websites/$WEBSITE_ID")"
expect404 "GET foreign website" "$code"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" -X PATCH "$BASE_URL/api/websites/$WEBSITE_ID" -H "Content-Type: application/json" -d '{"name":"pwned"}')"
expect404 "PATCH foreign website" "$code"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" -X POST "$BASE_URL/api/websites/$WEBSITE_ID/transfer" -H "Content-Type: application/json" -d "{\"toTeamId\":\"$TEAM_B_ID\"}")"
expect404 "transfer foreign website" "$code"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" -X POST "$BASE_URL/api/teams/$TEAM_A_ID/members" -H "Content-Type: application/json" -d '{"userId":"nonexistent","role":"TEAM_MEMBER"}')"
expect404 "add member to foreign team" "$code"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" -X PATCH "$BASE_URL/api/teams/$TEAM_A_ID" -H "Content-Type: application/json" -d '{"name":"pwned"}')"
expect404 "PATCH foreign team" "$code"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" -X POST "$BASE_URL/api/google/connections/disconnect" -H "Content-Type: application/json" -d "{\"connectionId\":\"$CONN_A_ID\"}")"
expect404 "disconnect foreign connection" "$code"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" "$BASE_URL/api/analytics/overview?websiteId=$WEBSITE_ID")"
expect404 "analytics for foreign website" "$code"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" -X POST "$BASE_URL/api/sync" -H "Content-Type: application/json" -d "{\"websiteId\":\"$WEBSITE_ID\",\"type\":\"integration-health-check\"}")"
expect404 "sync foreign website" "$code"
code="$(curl -s -o /dev/null -w "%{http_code}" -b "$ATTACKER_JAR" -X POST "$BASE_URL/api/transfers/$TRANSFER_ID/accept")"
expect404 "accept foreign transfer" "$code"
# List scoping: attacker lists must not leak demo-org rows.
curl -s -b "$ATTACKER_JAR" "$BASE_URL/api/websites?limit=200" | grep -q "$WEBSITE_ID" && fail "IDOR: attacker website list leaks demo website"
curl -s -b "$ATTACKER_JAR" "$BASE_URL/api/google/connections" | grep -q "ga-a@example.com" && fail "IDOR: attacker connection list leaks demo connection"
ok "IDOR matrix: 9 cross-tenant probes 404, lists scoped"

echo "smoke: ALL CHECKS PASSED"
