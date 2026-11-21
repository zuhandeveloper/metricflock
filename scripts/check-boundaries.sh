#!/usr/bin/env bash
# Package-boundary checks (CI-3 interim). typescript-eslint still does
# not support TypeScript 7 (peer range <6.1.0 as of 8.73.0), so the
# ESLint boundary rules in eslint.config.mjs cannot run on .ts/.tsx.
# Until upstream ships TS7 support, these grep checks enforce the same
# boundaries in `pnpm lint` (and therefore in CI):
#   1. Google SDKs are imported only inside packages/google.
#   2. @prisma/client is imported only inside packages/db.
#   3. No relative import reaches into another package/app.
#   4. No console.* in app/package src (use @metricflock/shared logger);
#      exceptions: the logger itself, the dev mail transport, the seed.
set -uo pipefail
fail=0
note() { echo "boundary FAIL: $*"; fail=1; }

# 1. Google SDK imports outside packages/google
hits=$(grep -rnE 'from "(googleapis|@google-analytics/|google-auth-library|@google-cloud/)' \
  apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v '^packages/google/' | grep -v node_modules || true)
[ -n "$hits" ] && note "Google SDK import outside packages/google:"$'\n'"$hits"

# 2. @prisma/client outside packages/db
hits=$(grep -rn '@prisma/client' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v '^packages/db/' | grep -v node_modules || true)
[ -n "$hits" ] && note "@prisma/client import outside packages/db:"$'\n'"$hits"

# 3. Relative imports escaping into another package/app
hits=$(grep -rnE 'from "\.\.[^"]*(packages|apps)/' apps packages --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v node_modules || true)
[ -n "$hits" ] && note "relative import into another package/app:"$'\n'"$hits"

# 4. console.* in src (logger/mailer/seed exempt; Next error boundaries
#    are client components — console is their only sink until an
#    error-reporting service is wired in)
hits=$(grep -rnE 'console\.(log|error|warn|info|debug)\(' \
  apps/web/src apps/worker/src packages/auth/src packages/db/src packages/google/src packages/jobs/src packages/shared/src \
  --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v 'packages/shared/src/logger.ts' \
  | grep -v 'packages/auth/src/mailer.ts' \
  | grep -v 'packages/db/src/seed.ts' \
  | grep -vE 'apps/web/src/.*error\.tsx' || true)
[ -n "$hits" ] && note "console.* in src (use the structured logger):"$'\n'"$hits"

if [ "$fail" = "1" ]; then exit 1; fi
echo "boundary checks passed"
