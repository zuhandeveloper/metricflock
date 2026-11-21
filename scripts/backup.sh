#!/usr/bin/env bash
# MetricFlock database backup (Stage 8). Dumps Postgres in pg_dump custom
# format (compressed, restorable with pg_restore). Redis is NOT backed
# up: it holds only cache entries, rate-limit counters and BullMQ queue
# state, all reconstructible (the scheduler re-enqueues due syncs; the
# durable job record is the AnalyticsSyncJob table in Postgres).
#
# Usage: DATABASE_URL=postgresql://... bash scripts/backup.sh [out-dir]
# Default out-dir: ./backups (created if missing). File name carries a
# UTC timestamp. See docs/operations/backup-restore.md for the runbook.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/metricflock-$STAMP.dump"

command -v pg_dump >/dev/null || { echo "pg_dump not found — install postgresql-client" >&2; exit 1; }
pg_dump "$DATABASE_URL" -Fc -f "$OUT"
echo "backup written: $OUT ($(du -h "$OUT" | cut -f1))"
