# Backup & Restore Runbook

## What is backed up

**Postgres only.** It holds everything durable: users, organizations,
teams, websites, Google connections (encrypted tokens), mappings,
sync-job bookkeeping, audit log, OAuth state.

**Redis is deliberately not backed up.** It holds cache entries,
rate-limit counters, BullMQ queue state and scheduler locks — all
reconstructible. After a Redis loss the scheduler re-enqueues due
syncs on its next tick and the cache repopulates on demand. The
durable record of every sync is the `AnalyticsSyncJob` table.

## Taking a backup

```bash
DATABASE_URL=postgresql://… bash scripts/backup.sh ./backups
```

Produces `backups/metricflock-<UTC timestamp>.dump` (pg_dump custom
format, compressed). Requires `postgresql-client` (`pg_dump`) on the
machine running the script — use a client whose major version matches
your Postgres server (a newer client can emit settings an older
server rejects on restore).

Recommended cadence: daily, retained 7 days + one weekly retained 4
weeks, copied off the database host. If your Postgres provider (e.g.
Prisma Postgres, Neon, RDS) offers automated backups / point-in-time
recovery, prefer that as the primary mechanism and keep a manual
`backup.sh` dump before every production migration as a second copy.

## Restoring

1. Stop the web app and the worker (no writes during restore).
2. Restore:

   ```bash
   DATABASE_URL=postgresql://… bash scripts/restore.sh backups/metricflock-<stamp>.dump
   ```

   This drops existing objects and replaces the database contents.

3. Run migrations (in case the backup predates a migration the
   deployed code expects):

   ```bash
   pnpm db:migrate
   ```

4. Start the worker and web app. Verify `GET /api/health/ready`
   returns `ready`, sign in, and confirm a dashboard loads.
5. Note: Google access tokens are encrypted with
   `GOOGLE_TOKEN_ENCRYPTION_KEY` — a restore onto an environment with
   a **different** key makes stored tokens unreadable (connections
   will fail refresh and need reconnecting). Restore with the same
   key, or plan to reconnect Google accounts. See
   `docs/token-encryption-rotation.md`.

## Restore drill (tested)

Every CI run executes a real backup → restore → verify drill in
`scripts/smoke-test.sh`: it dumps the smoke database, restores it
into a scratch database, asserts user + migration rows survived, and
drops the scratch database. A green CI run therefore proves the
backup format and restore commands above actually work against the
current schema.

To run the drill manually against any database: take a backup with
`backup.sh`, create a scratch database, restore into it with
`restore.sh` (pointing `DATABASE_URL` at the scratch DB), and check
`SELECT count(*) FROM "User"`.
