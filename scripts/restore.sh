#!/usr/bin/env bash
# MetricFlock database restore (Stage 8). Restores a pg_dump custom-format
# backup produced by scripts/backup.sh into the target database.
#
# Usage: DATABASE_URL=postgresql://... bash scripts/restore.sh <backup.dump>
#
# WARNING: this REPLACES the target database's contents. pg_restore runs
# with --clean --if-exists (drops existing objects first). Stop the web
# app and worker before restoring, then run `pnpm db:migrate` afterwards
# in case the backup predates a migration the deployed code expects.
# See docs/operations/backup-restore.md.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"
BACKUP="${1:?usage: restore.sh <backup.dump>}"
[ -f "$BACKUP" ] || { echo "backup file not found: $BACKUP" >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore not found — install postgresql-client" >&2; exit 1; }

echo "Restoring $BACKUP into the database at DATABASE_URL (existing objects will be dropped)…"
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" "$BACKUP"
echo "restore complete. Now run: pnpm db:migrate"
