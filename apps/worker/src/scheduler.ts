// Centralized sync scheduler (spec §15). One tick per minute (guarded by a
// Redis lock so multiple worker instances never double-enqueue) decides which
// websites are due for which sync, using SYNC_INTERVALS and each website's
// last successful sync. Jobs carry bucketed dedup jobIds, so repeat ticks
// inside the same interval window are no-ops in BullMQ.
//
// Also enqueues: OAuth refresh for connections whose access token expires
// within 10 minutes, and property discovery for connections with no
// discovered properties yet.
import { randomUUID } from "node:crypto";
import { prisma } from "@metricflock/db";
import { getRedis, createLogger, errMeta, incr, auditRetentionDays, getReportDueKind } from "@metricflock/shared";

const log = createLogger("scheduler");
import {
  enqueueBulk,
  getQueue,
  planDueSyncs,
  JOB_PRIORITY,
  type EnqueueEntry,
  type SyncProviderName,
} from "@metricflock/jobs";
import { adManagerEnabled } from "@metricflock/google/ad-manager";

type RedisClient = NonNullable<ReturnType<typeof getRedis>>;

const TICK_MS = 60_000;
const LOCK_KEY = "metricflock:scheduler:lock";
const LOCK_TTL_MS = 55_000;
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
// A-WRK-04: the lock TTL (55 s) used to be shorter than an unbounded
// tick, so a slow tick let a second instance acquire the expired lock
// and double-schedule. The tick now renews the lock while it runs
// (heartbeat at ~1/3 TTL, atomic check-and-PEXPIRE so a lock we no
// longer own is never extended), and a watchdog aborts the tick at
// the next phase boundary if it runs past TICK_TIMEOUT_MS. The TTL
// itself stays 55 s on purpose: a crashed worker stops renewing, so
// its lock still frees within ~55 s.
const LOCK_RENEW_MS = 20_000;
const TICK_TIMEOUT_MS = 120_000;
const RENEW_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
// OPS-2 backpressure: skip realtime enqueues while the queue already holds
// more than this many waiting+delayed jobs (2 minutes of limiter capacity).
const REALTIME_BACKPRESSURE_DEPTH = 40;
// OPS-3 retention: bookkeeping rows older than this are pruned per tick.
const RETENTION_DAYS = 30;
// Phase 4 (F-4.3, docs/security/data-lifecycle.md): audit logs are kept
// for AUDIT_RETENTION_DAYS (default 365, parsed in @metricflock/shared);
// OAuth flow state is single-use with a 10-minute TTL, so anything
// expired for over a day is dead weight.
const WEBSITE_PAGE_SIZE = 500;
// A-DB-05: shell-org sweep batch cap per tick (see the sweep below).
const SHELL_ORG_SWEEP_BATCH = 100;
// A-DB-10: retention pruning runs in bounded batches — Prisma's
// deleteMany has no take/limit, so each batch first selects up to
// PRUNE_BATCH_SIZE ids and then deletes exactly those rows. At most
// MAX_PRUNE_BATCHES_PER_TICK batches run per table per tick, so a
// huge backlog (e.g. after a worker outage) drains over several ticks
// instead of one long-running DELETE holding locks and blocking the
// scheduler. A single sync attempt takes minutes (per-call API
// timeouts are 15s) and a full BullMQ retry cycle (5 attempts, 60s
// doubling backoff capped at 1h) completes in well under 6 hours, so
// a RUNNING row older than STALE_RUNNING_MS has no live attempt
// behind it — a live attempt refreshes updatedAt at pickup, and a
// BullMQ stalled-job re-queue does the same.
const PRUNE_BATCH_SIZE = 1000;
const MAX_PRUNE_BATCHES_PER_TICK = 10;
const STALE_RUNNING_MS = 6 * 3_600_000;

// A-DB-10: delete at most PRUNE_BATCH_SIZE rows per statement, at most
// MAX_PRUNE_BATCHES_PER_TICK statements per table per tick. Returns
// the total deleted and whether the per-tick cap stopped the drain
// (more rows remain for the next tick).
async function pruneInBatches(
  findIds: () => Promise<{ id: string }[]>,
  deleteIds: (ids: string[]) => Promise<{ count: number }>,
): Promise<{ pruned: number; capped: boolean }> {
  let pruned = 0;
  for (let batch = 0; batch < MAX_PRUNE_BATCHES_PER_TICK; batch++) {
    const rows = await findIds();
    if (rows.length === 0) return { pruned, capped: false };
    const deleted = await deleteIds(rows.map((r) => r.id));
    pruned += deleted.count;
    if (rows.length < PRUNE_BATCH_SIZE) return { pruned, capped: false };
  }
  return { pruned, capped: true };
}

let tickRunning = false;

async function tick(redis: RedisClient): Promise<void> {
  if (tickRunning) return; // OPS-7: never overlap ticks in-process
  tickRunning = true;
  const token = randomUUID(); // OPS-7: unique per tick (pid is 1 in every container)
  const startedAt = Date.now();
  try {
    const acquired = await redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
    if (acquired !== "OK") return; // another instance is scheduling this tick
    const controller = new AbortController();
    // A-WRK-04: heartbeat — extend the lock while the tick runs so a
    // slow tick (10k sites, prune backlog) can never outlive the 55 s
    // TTL and let a second instance double-schedule.
    const renewTimer = setInterval(() => {
      redis
        .eval(RENEW_LUA, 1, LOCK_KEY, token, LOCK_TTL_MS)
        .then((renewed) => {
          if (renewed === 1) return;
          // The lock is no longer ours (expired and taken by another
          // instance, or released): abort at the next phase boundary
          // instead of running alongside the instance that took it.
          log.warn("scheduler lock lost during tick; aborting tick", {});
          incr("scheduler.lock_lost");
          controller.abort();
          clearInterval(renewTimer);
        })
        .catch(() => {
          // A failed renewal is not proof the lock is lost (Redis may
          // be briefly unreachable, and an unreachable Redis cannot
          // hand the lock to another instance either); leave the abort
          // to the next renewal attempt or the watchdog.
          incr("scheduler.lock_renew_failed");
        });
    }, LOCK_RENEW_MS);
    // A-WRK-04: watchdog — a tick that runs past two intervals is
    // pathological; abort it at the next phase boundary so the next
    // tick can proceed, and count it.
    const timeoutTimer = setTimeout(() => {
      log.warn("scheduler tick timed out; aborting tick", { timeoutMs: TICK_TIMEOUT_MS });
      incr("scheduler.tick_timeout");
      controller.abort();
    }, TICK_TIMEOUT_MS);
    try {
      await runTick(controller.signal);
    } catch (err) {
      // An aborted tick (lock lost or watchdog) is already logged and
      // counted at the abort site; don't re-report it as a generic
      // tick failure, and don't record it as a completed tick.
      if (!controller.signal.aborted) throw err;
      return;
    } finally {
      clearInterval(renewTimer);
      clearTimeout(timeoutTimer);
      // OPS-7: release only our own lock (compare-and-delete).
      await redis.eval(RELEASE_LUA, 1, LOCK_KEY, token).catch(() => {});
    }
    // A-WRK-04: record tick duration (sum counter; the metrics
    // endpoint snapshots counters, so the average is derivable).
    const durationMs = Date.now() - startedAt;
    incr("scheduler.tick_duration_ms", durationMs);
    log.info("tick completed", { durationMs });
  } finally {
    tickRunning = false;
  }
}

async function runTick(signal?: AbortSignal): Promise<void> {
  const now = new Date();

  // A-WRK-04: phase-boundary abort checks — the heartbeat/watchdog
  // abort the signal; the tick stops here (before enqueueing or
  // pruning anything further) instead of running to completion.
  const checkAborted = () => signal?.throwIfAborted();

  // OPS-11: paginate websites instead of loading every mapped site at once.
  // A-WRK-09: the scan used to filter only on a MAPPED integration, so
  // ARCHIVED / SOLD / TRANSFER_PENDING / DISCONNECTED sites kept being
  // synced every interval — burning Google quota and capable of
  // generating health-failure alert emails for a retired site. Only
  // ACTIVE and PENDING_SETUP sites are scanned now. DISCONNECTED is
  // deliberately excluded: its connection is gone, so every sync would
  // only ever record "not_connected" health (noise, no data). A
  // reconnected site is reactivated by flipping its status back to
  // ACTIVE in the website actions UI — the map route only auto-flips
  // PENDING_SETUP -> ACTIVE on first mapping and leaves manually set
  // states (DISCONNECTED/ARCHIVED) alone. TRANSFER_PENDING is excluded
  // because the site is mid-transfer (A-DB-04 freezes team/status
  // changes for the whole open-transfer window); SOLD and ARCHIVED are
  // retired. Mappings are NOT unmapped or auto-paused: they are user
  // data, kept intact so a site can be reactivated by a status flip
  // (un-archiving, a sale falling through) without re-discovery.
  // A-WRK-05: the last-success lookup used to be one unscoped groupBy
  // over every SUCCEEDED row in 30 days, run on every tick — tick
  // latency grew with total portfolio history, not with due work. It is
  // now scoped per website page: the groupBy only ever sees the ids of
  // the page just loaded (at most WEBSITE_PAGE_SIZE), served by the
  // @@index([websiteId, type, status, updatedAt]) index. planDueSyncs
  // only looks up lastSucceededAt for websites in the loaded list, so
  // the due decision is identical — rows for other websites were never
  // read. The 30-day window is unchanged (older successes are
  // equivalent to "never" for due purposes).
  const websites: { id: string; providers: SyncProviderName[] }[] = [];
  const windowStart = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const lastSucceededAt = new Map<string, Date | null>();
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.website.findMany({
      where: { status: { in: ["ACTIVE", "PENDING_SETUP"] }, integrations: { some: { mappingStatus: "MAPPED" } } },
      select: { id: true, integrations: { where: { mappingStatus: "MAPPED" }, select: { provider: true } } },
      orderBy: { id: "asc" },
      take: WEBSITE_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const pageIds = page.map((w) => w.id);
    if (pageIds.length > 0) {
      const lastRows = await prisma.analyticsSyncJob.groupBy({
        by: ["websiteId", "type"],
        where: { status: "SUCCEEDED", websiteId: { in: pageIds }, updatedAt: { gte: windowStart } },
        _max: { updatedAt: true },
      });
      for (const row of lastRows) {
        if (row.websiteId) lastSucceededAt.set(`${row.websiteId}:${row.type}`, row._max.updatedAt);
      }
    }
    for (const w of page) {
      websites.push({ id: w.id, providers: [...new Set(w.integrations.map((i) => i.provider as SyncProviderName))] });
    }
    if (page.length < WEBSITE_PAGE_SIZE) break;
    cursor = page[page.length - 1]!.id;
    checkAborted();
  }
  checkAborted();
  let plan = planDueSyncs({ websites, lastSucceededAt, now, adManagerEnabled: adManagerEnabled() });

  // OPS-2 backpressure: if realtime is already backed up, skip this tick's
  // realtime enqueues (coalescing means the pending jobs still cover every
  // site; the dashboard fetches live on cache miss regardless).
  const realtimeQueue = getQueue("ga4-realtime-sync");
  if (realtimeQueue && plan.some((p) => p.queue === "ga4-realtime-sync")) {
    const counts = await realtimeQueue.getJobCounts("waiting", "delayed").catch(() => null);
    const depth = counts ? (counts.waiting ?? 0) + (counts.delayed ?? 0) : 0;
    if (depth > REALTIME_BACKPRESSURE_DEPTH) {
      log.warn("realtime backpressure: skipping realtime enqueues this tick", { depth });
      incr("scheduler.realtime_backpressure");
      plan = plan.filter((p) => p.queue !== "ga4-realtime-sync");
    }
  }

  const entries: EnqueueEntry[] = plan.map((p) => ({
    name: p.queue,
    data: { websiteId: p.websiteId },
    jobId: p.jobId,
    delayMs: p.delayMs,
    // Realtime refreshes outrank other scheduled work (F-5.5).
    priority: p.queue === "ga4-realtime-sync" ? JOB_PRIORITY.REALTIME : JOB_PRIORITY.SCHEDULED,
  }));

  const expiring = await prisma.googleConnection.findMany({
    where: { status: "ACTIVE", tokenExpiresAt: { not: null, lt: new Date(now.getTime() + 10 * 60_000) } },
    select: { id: true },
  });
  const hourBucket = Math.floor(now.getTime() / 3_600_000);
  for (const conn of expiring) {
    entries.push({
      name: "google-oauth-refresh",
      data: { connectionId: conn.id },
      jobId: `google-oauth-refresh:${conn.id}:${hourBucket}`,
    });
  }

  const undiscovered = await prisma.googleConnection.findMany({
    where: {
      status: "ACTIVE",
      properties: { none: {} },
      searchConsoleProps: { none: {} },
      adsenseAccounts: { none: {} },
      adManagerNetworks: { none: {} },
    },
    select: { id: true },
  });
  const dayBucket = Math.floor(now.getTime() / 86_400_000);
  for (const conn of undiscovered) {
    entries.push({
      name: "google-property-discovery",
      data: { connectionId: conn.id },
      jobId: `google-property-discovery:${conn.id}:${dayBucket}`,
    });
  }

  // Phase 7.3: weekly portfolio reports. One job per due organization
  // per day (stable jobId dedupes repeat ticks inside the send hour;
  // lastSentAt guards the week).
  // A-WRK-06: a missed send hour used to lose a whole week — the
  // schedule was not due again until the same weekday/hour next week,
  // silently. A schedule whose last send is >= 7 days old is now due
  // as a catch-up on the next tick, whatever the hour, and the missed
  // window is surfaced with scheduler.report_missed. The catch-up is
  // capped to one send per missed week: the dayBucket jobId dedupes
  // repeat ticks within the day, and the report job records lastSentAt
  // once >= 1 recipient is mailed, so the schedule stops being due.
  const schedules = await prisma.reportSchedule.findMany({ where: { enabled: true } });
  let reportsDue = 0;
  for (const s of schedules) {
    const dueKind = getReportDueKind(s, now);
    if (dueKind === null) continue;
    if (dueKind === "catch-up") {
      // Fires once per tick while the catch-up is pending (usually 1-2
      // ticks until the send lands and lastSentAt advances); the jobId
      // dedupe, not this counter, is what prevents duplicate sends.
      incr("scheduler.report_missed");
      log.warn("weekly report window missed — sending catch-up", {
        organizationId: s.organizationId,
        lastSentAt: s.lastSentAt,
      });
    }
    entries.push({
      name: "scheduled-report",
      data: { organizationId: s.organizationId },
      jobId: `scheduled-report:${s.organizationId}:${dayBucket}`,
    });
    reportsDue += 1;
  }

  checkAborted();
  // OPS-7/11: one bulk round trip per queue instead of sequential awaits.
  const submitted = await enqueueBulk(entries);
  if (submitted) {
    log.info("tick enqueued jobs", {
      enqueued: submitted,
      syncs: plan.length,
      oauthRefresh: expiring.length,
      discovery: undiscovered.length,
    });
  }
  checkAborted();

  // A-DB-10: resolve stuck sync jobs before pruning. A RUNNING row
  // older than STALE_RUNNING_MS has no live attempt behind it (worker
  // crash mid-run) — mark it FAILED with lastError "stale_running"
  // instead of deleting it, so the failure stays visible in the
  // failed-jobs UI and the website becomes due again (planDueSyncs
  // only looks at SUCCEEDED, so the next tick re-enqueues a fresh
  // sync). The row is then removed by the 30-day FAILED prune below
  // (marking it refreshes updatedAt, so it lingers up to 30 more days
  // as FAILED — deliberate, for visibility).
  const staleCutoff = new Date(now.getTime() - STALE_RUNNING_MS);
  const stale = await prisma.analyticsSyncJob.updateMany({
    where: { status: "RUNNING", updatedAt: { lt: staleCutoff } },
    data: { status: "FAILED", lastError: "stale_running" },
  });
  if (stale.count) log.info("marked stale running sync jobs failed", { count: stale.count });

  // OPS-3 retention: prune old bookkeeping in bounded batches
  // (A-DB-10: the old unbounded deleteMany calls are gone). The
  // sync-job prune covers every terminal/orphaned status, not just
  // SUCCEEDED/FAILED: a PENDING row older than 30d is a manual-sync
  // row whose enqueue failed, and a RETRYING row older than 30d is
  // past any possible retry cycle (5 attempts, backoff capped at 1h)
  // — both are orphaned, and no live BullMQ job can still reference
  // them. RUNNING rows are never pruned here; the staleness rule
  // above resolves them first.
  checkAborted();
  const pruned = await pruneInBatches(
    () =>
      prisma.analyticsSyncJob.findMany({
        where: { updatedAt: { lt: windowStart }, status: { in: ["SUCCEEDED", "FAILED", "PENDING", "RETRYING"] } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: PRUNE_BATCH_SIZE,
      }),
    (ids) => prisma.analyticsSyncJob.deleteMany({ where: { id: { in: ids } } }),
  );
  if (pruned.pruned) log.info("pruned old sync-job rows", { count: pruned.pruned, capped: pruned.capped });

  // Phase 4 (F-4.3) retention: expired OAuth flow state (>1 day past
  // expiry — consumed or abandoned), expired analytics cache rows, and
  // audit logs past the retention window (AUDIT_RETENTION_DAYS, 365).
  const oneDayAgo = new Date(now.getTime() - 86_400_000);
  checkAborted();
  const prunedStates = await pruneInBatches(
    () =>
      prisma.oAuthState.findMany({
        where: { expiresAt: { lt: oneDayAgo } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: PRUNE_BATCH_SIZE,
      }),
    (ids) => prisma.oAuthState.deleteMany({ where: { id: { in: ids } } }),
  );
  if (prunedStates.pruned)
    log.info("pruned expired OAuth states", { count: prunedStates.pruned, capped: prunedStates.capped });
  checkAborted();
  const prunedCache = await pruneInBatches(
    () =>
      prisma.analyticsCache.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: PRUNE_BATCH_SIZE,
      }),
    (ids) => prisma.analyticsCache.deleteMany({ where: { id: { in: ids } } }),
  );
  if (prunedCache.pruned)
    log.info("pruned expired analytics cache rows", { count: prunedCache.pruned, capped: prunedCache.capped });
  // A-DB-05: sweep abandoned shell orgs left behind when the
  // invite-accept delete could not run — audit history blocks it via the
  // Restrict FK, or data arrived between the move and the delete. This
  // runs inside the existing 1-minute tick (no new job/cron). Bounded:
  // at most SHELL_ORG_SWEEP_BATCH candidates per tick. An org is only
  // removed when it is empty in every sense — no users, teams, websites
  // or connections, no audit rows (the Restrict FK would reject the
  // delete otherwise) and no live pending invite (a live invite is a
  // path back into the org; expired/accepted invites do not block).
  // The guard is re-applied in the deleteMany itself, so an org that
  // gains a member between the lookup and the delete is never removed.
  checkAborted();
  const shellOrgCandidates = await prisma.organization.findMany({
    where: {
      users: { none: {} },
      teams: { none: {} },
      websites: { none: {} },
      connections: { none: {} },
      auditLogs: { none: {} },
      invites: { none: { acceptedAt: null, expiresAt: { gt: now } } },
    },
    select: { id: true },
    take: SHELL_ORG_SWEEP_BATCH,
  });
  if (shellOrgCandidates.length > 0) {
    const sweptOrgs = await prisma.organization.deleteMany({
      where: {
        id: { in: shellOrgCandidates.map((o) => o.id) },
        users: { none: {} },
        teams: { none: {} },
        websites: { none: {} },
        connections: { none: {} },
        auditLogs: { none: {} },
        invites: { none: { acceptedAt: null, expiresAt: { gt: now } } },
      },
    });
    if (sweptOrgs.count) log.info("swept member-less shell orgs", { count: sweptOrgs.count });
  }

  const auditCutoff = new Date(now.getTime() - auditRetentionDays() * 86_400_000);
  checkAborted();
  const prunedAudit = await pruneInBatches(
    () =>
      prisma.auditLog.findMany({
        where: { createdAt: { lt: auditCutoff } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: PRUNE_BATCH_SIZE,
      }),
    (ids) => prisma.auditLog.deleteMany({ where: { id: { in: ids } } }),
  );
  if (prunedAudit.pruned) log.info("pruned old audit logs", { count: prunedAudit.pruned, capped: prunedAudit.capped });

  // A-DB-13: the four tables the original retention prune missed.
  // Expired unaccepted invites (the accept route already conflates
  // expired with never-existed — "invite_not_found_or_expired" — so
  // pruning them changes no message); accepted invites are kept as
  // the record of who joined. Expired better-auth verifications
  // (email / password-reset rows; only deleted on use) and expired
  // sessions (better-auth validates expiry on load, so an expired row
  // is already unusable). IntegrationHealth rows with no website are
  // unreadable — no consumer can find them by the unique key — so
  // every one is pruned regardless of age; recordHealth no longer
  // creates them.
  checkAborted();
  const prunedInvites = await pruneInBatches(
    () =>
      prisma.organizationInvite.findMany({
        where: { acceptedAt: null, expiresAt: { lt: now } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: PRUNE_BATCH_SIZE,
      }),
    (ids) => prisma.organizationInvite.deleteMany({ where: { id: { in: ids } } }),
  );
  if (prunedInvites.pruned)
    log.info("pruned expired invites", { count: prunedInvites.pruned, capped: prunedInvites.capped });
  checkAborted();
  const prunedVerifications = await pruneInBatches(
    () =>
      prisma.verification.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: PRUNE_BATCH_SIZE,
      }),
    (ids) => prisma.verification.deleteMany({ where: { id: { in: ids } } }),
  );
  if (prunedVerifications.pruned)
    log.info("pruned expired verifications", { count: prunedVerifications.pruned, capped: prunedVerifications.capped });
  checkAborted();
  const prunedSessions = await pruneInBatches(
    () =>
      prisma.session.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: PRUNE_BATCH_SIZE,
      }),
    (ids) => prisma.session.deleteMany({ where: { id: { in: ids } } }),
  );
  if (prunedSessions.pruned)
    log.info("pruned expired sessions", { count: prunedSessions.pruned, capped: prunedSessions.capped });
  checkAborted();
  const prunedNullHealth = await pruneInBatches(
    () =>
      prisma.integrationHealth.findMany({
        where: { websiteId: null },
        select: { id: true },
        orderBy: { id: "asc" },
        take: PRUNE_BATCH_SIZE,
      }),
    (ids) => prisma.integrationHealth.deleteMany({ where: { id: { in: ids } } }),
  );
  if (prunedNullHealth.pruned)
    log.info("pruned NULL-website health rows", { count: prunedNullHealth.pruned, capped: prunedNullHealth.capped });
}

export function startScheduler(redis: RedisClient): { stop: () => Promise<void> } {
  // A-WRK-11: track the in-flight tick so stop() can await it — a tick
  // already running must not keep enqueueing while the workers close.
  // The promise never rejects (run() below swallows tick errors after
  // logging), so stop() never throws from the tick.
  let currentTick: Promise<void> | null = null;
  const run = () => {
    currentTick = tick(redis).catch((err) => {
      incr("scheduler.tick_failed");
      log.error("tick failed", errMeta(err));
    });
  };
  run();
  const timer = setInterval(run, TICK_MS);
  log.info("scheduler started", { tickMs: TICK_MS });
  return {
    stop: async () => {
      clearInterval(timer);
      await currentTick;
    },
  };
}
