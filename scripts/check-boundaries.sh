#!/usr/bin/env bash
# Package-boundary checks (CI-3 interim). typescript-eslint still does
# not support TypeScript 7: latest stable is 8.74.0 with peer range
# typescript >=4.8.4 <6.1.0 (checked 2026-11-24), while this repo uses
# TypeScript 7.0.2 — so the ESLint boundary rules in eslint.config.mjs
# cannot run on .ts/.tsx. Until upstream ships TS 7 support, these grep
# checks enforce the same boundaries in `pnpm lint` (and therefore in CI):
#   1. Google SDKs are imported only inside packages/google.
#   2. @prisma/client is imported only inside packages/db.
#   3. No relative import reaches into another package/app.
#   4. No console.* in app/package src (use @metricflock/shared logger);
#      exceptions: the logger itself, the dev mail transport, the seed.
#   5. better-auth is imported only inside packages/auth, except
#      better-auth/crypto inside packages/db (seed + smoke scripts).
#   6. bullmq is imported only inside packages/jobs and apps/worker.
#   7. ioredis is imported only inside packages/shared.
#   8. No explicit `any` in app/package src (tests are out of scope —
#      test doubles use `any` for fake options, e.g. worker-index.test.ts).
#
# What is still NOT enforced (A-COV-09 residual): unused imports and
# variables. A `tsc --noUnusedLocals --noUnusedParameters` run finds 5
# violations today, 4 of them in test files owned by pending fixes
# (dark-mode-contrast.test.ts, scheduler-report-catchup.test.ts,
# route-remaining.test.ts, worker-index-default-port.test.ts) and 1 in
# packages/db/src/client.ts (fixed 2026-11-24). The follow-up is to
# enable noUnusedLocals/noUnusedParameters in the tsconfigs once those
# pushes land. `pnpm lint` prints a WARNING (below) on every run so the
# green is never mistaken for full ESLint coverage of TypeScript.
#
# Regression test (A-COV-09): every check_* function below is also run
# against a fixture tree in the self-test at the end of this script, with
# one planted violation per rule (plus legal-import fixtures that must
# NOT trip). If a pattern stops matching, the self-test fails the gate —
# the enforcement cannot silently go vacuous again.
set -uo pipefail
fail=0
note() { echo "boundary FAIL: $*"; fail=1; }

# Each check_* prints the violating lines (if any) for the repo rooted at
# the CWD. The real run executes them at the repo root; the self-test
# executes the same functions inside a fixture tree.
check_google() {
  grep -rnE 'from "(googleapis|@google-analytics/|google-auth-library|@google-cloud/)' \
    apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v '^packages/google/' | grep -v node_modules || true
}

check_prisma() {
  grep -rn '@prisma/client' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v '^packages/db/' | grep -v node_modules || true
}

check_relative() {
  grep -rnE 'from "\.\.[^"]*(packages|apps)/' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v node_modules || true
}

check_console() {
  grep -rnE 'console\.(log|error|warn|info|debug)\(' \
    apps/web/src apps/worker/src packages/auth/src packages/db/src packages/google/src packages/jobs/src packages/shared/src \
    --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v 'packages/shared/src/logger.ts' \
    | grep -v 'packages/auth/src/mailer.ts' \
    | grep -v 'packages/db/src/seed.ts' \
    | grep -vE 'apps/web/src/.*error\.tsx' || true
}

check_better_auth() {
  # Bare "better-auth" only in packages/auth; subpaths only in
  # packages/auth, plus better-auth/crypto in packages/db.
  {
    grep -rnE 'from "better-auth"' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
      | grep -v '^packages/auth/' | grep -v node_modules || true
    grep -rnE 'from "better-auth/' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
      | grep -v '^packages/auth/' | grep -v '^packages/db/.*better-auth/crypto' | grep -v node_modules || true
  }
}

check_bullmq() {
  grep -rnE 'from "bullmq' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v '^packages/jobs/' | grep -v '^apps/worker/' | grep -v node_modules || true
}

check_ioredis() {
  grep -rnE 'from "ioredis' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v '^packages/shared/' | grep -v node_modules || true
}

check_any() {
  grep -rnE '(: any\b|as any\b|<any\b|, any\b|\(any\b[),]| any\b \||\| any\b|any\b\[\])' \
    apps/web/src apps/worker/src packages/auth/src packages/db/src packages/google/src packages/jobs/src packages/shared/src \
    --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v node_modules || true
}

# Real run: each check against the repo root.
hits=$(check_google); [ -n "$hits" ] && note "Google SDK import outside packages/google:"$'\n'"$hits"
hits=$(check_prisma); [ -n "$hits" ] && note "@prisma/client import outside packages/db:"$'\n'"$hits"
hits=$(check_relative); [ -n "$hits" ] && note "relative import into another package/app:"$'\n'"$hits"
hits=$(check_console); [ -n "$hits" ] && note "console.* in src (use the structured logger):"$'\n'"$hits"
hits=$(check_better_auth); [ -n "$hits" ] && note "better-auth import outside packages/auth (better-auth/crypto allowed only in packages/db):"$'\n'"$hits"
hits=$(check_bullmq); [ -n "$hits" ] && note "bullmq import outside packages/jobs and apps/worker:"$'\n'"$hits"
hits=$(check_ioredis); [ -n "$hits" ] && note "ioredis import outside packages/shared:"$'\n'"$hits"
hits=$(check_any); [ -n "$hits" ] && note "explicit any in src (use a precise type):"$'\n'"$hits"

if [ "$fail" = "1" ]; then exit 1; fi

# Self-test (A-COV-09 regression test): plant one violating fixture per
# rule in a temp tree that mirrors the repo layout, plus legal-import
# fixtures that must NOT trip. Runs the same check_* functions, so a
# pattern that stops matching fails the gate instead of going vacuous.
self_test() {
  local tmp st
  tmp=$(mktemp -d)
  mkdir -p "$tmp/apps/web/src" "$tmp/apps/worker/src" \
    "$tmp/packages/auth/src" "$tmp/packages/db/src" \
    "$tmp/packages/google/src" "$tmp/packages/jobs/src" \
    "$tmp/packages/shared/src"
  # Violations (each must be caught).
  printf 'import { google } from "googleapis";\n' > "$tmp/packages/db/src/st-google.ts"
  printf 'import { PrismaClient } from "@prisma/client";\n' > "$tmp/packages/auth/src/st-prisma.ts"
  printf 'import { x } from "../../../packages/db/src/client";\n' > "$tmp/apps/web/src/st-relative.ts"
  printf 'console.log("self-test");\n' > "$tmp/apps/web/src/st-console.ts"
  printf 'import { betterAuth } from "better-auth";\n' > "$tmp/packages/google/src/st-better-auth.ts"
  printf 'import { hashPassword } from "better-auth/crypto";\n' > "$tmp/packages/google/src/st-better-auth-crypto.ts"
  printf 'import { Queue } from "bullmq";\n' > "$tmp/apps/web/src/st-bullmq.ts"
  printf 'import Redis from "ioredis";\n' > "$tmp/apps/web/src/st-ioredis.ts"
  printf 'export const x: any = 1;\n' > "$tmp/packages/shared/src/st-any.ts"
  # Legal imports (must NOT be caught).
  printf 'import { google } from "googleapis";\n' > "$tmp/packages/google/src/st-google-legal.ts"
  printf 'import { betterAuth } from "better-auth";\n' > "$tmp/packages/auth/src/st-better-auth-legal.ts"
  printf 'import { hashPassword } from "better-auth/crypto";\n' > "$tmp/packages/db/src/st-better-auth-crypto-legal.ts"
  printf 'console.error("boom");\n' > "$tmp/apps/web/src/st-error.tsx"
  st=0
  (
    cd "$tmp" || exit 1
    hits=$(check_google)
    case "$hits" in *st-google.ts*) ;; *) echo "boundary self-test FAIL: check_google missed its fixture"; st=1;; esac
    case "$hits" in *st-google-legal.ts*) echo "boundary self-test FAIL: check_google flagged a legal import"; st=1;; esac
    hits=$(check_prisma)
    case "$hits" in *st-prisma.ts*) ;; *) echo "boundary self-test FAIL: check_prisma missed its fixture"; st=1;; esac
    hits=$(check_relative)
    case "$hits" in *st-relative.ts*) ;; *) echo "boundary self-test FAIL: check_relative missed its fixture"; st=1;; esac
    hits=$(check_console)
    case "$hits" in *st-console.ts*) ;; *) echo "boundary self-test FAIL: check_console missed its fixture"; st=1;; esac
    case "$hits" in *st-error.tsx*) echo "boundary self-test FAIL: check_console flagged an error boundary"; st=1;; esac
    hits=$(check_better_auth)
    case "$hits" in *st-better-auth.ts*) ;; *) echo "boundary self-test FAIL: check_better_auth missed its fixture"; st=1;; esac
    case "$hits" in *st-better-auth-crypto.ts*) ;; *) echo "boundary self-test FAIL: check_better_auth missed the crypto fixture"; st=1;; esac
    case "$hits" in *st-better-auth-legal.ts*) echo "boundary self-test FAIL: check_better_auth flagged a legal import"; st=1;; esac
    case "$hits" in *st-better-auth-crypto-legal.ts*) echo "boundary self-test FAIL: check_better_auth flagged legal db crypto use"; st=1;; esac
    hits=$(check_bullmq)
    case "$hits" in *st-bullmq.ts*) ;; *) echo "boundary self-test FAIL: check_bullmq missed its fixture"; st=1;; esac
    hits=$(check_ioredis)
    case "$hits" in *st-ioredis.ts*) ;; *) echo "boundary self-test FAIL: check_ioredis missed its fixture"; st=1;; esac
    hits=$(check_any)
    case "$hits" in *st-any.ts*) ;; *) echo "boundary self-test FAIL: check_any missed its fixture"; st=1;; esac
    exit "$st"
  ) || st=1
  rm -rf "$tmp"
  return "$st"
}

if ! self_test; then
  echo "boundary self-test FAILED — a check no longer catches its fixture (see above)"
  exit 1
fi

echo "boundary checks passed"
echo "WARNING (A-COV-09): ESLint does not lint .ts/.tsx — typescript-eslint 8.74.0 supports TypeScript <6.1.0 only (repo uses 7.0.2)."
echo "WARNING (A-COV-09): boundary rules for .ts/.tsx are enforced by the grep checks above, not by ESLint; unused imports/variables are still unenforced."
