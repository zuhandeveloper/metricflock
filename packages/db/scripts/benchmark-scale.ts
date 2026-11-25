// Scale benchmark (Phase 5, brief 5.3): measures the dashboard query
// set and scheduler inputs at 100 / 1k / 10k websites against a REAL
// database. Creates a scratch organization, seeds it, times the
// queries the dashboard page and scheduler actually run, then deletes
// the scratch org (cascade).
//
// Usage (from repo root):
//   BENCH_CONFIRM=1 pnpm --filter @metricflock/db exec tsx scripts/benchmark-scale.ts
// Optional: BENCH_SIZES=100,1000 to run a subset.
//
// A-WRK-12: the script now measures the production queries — the
// scheduler page scan matches the production tick (`status: { in:
// ["ACTIVE", "PENDING_SETUP"] }` + MAPPED-integration filter,
// A-WRK-09), the last-success groupBy is the per-page scoped shape
// (A-WRK-05, 500 ids), and the seed includes FAILED/RETRYING sync-job
// rows, audit-log rows and analytics-cache rows so the DLQ, audit and
// snapshot reads and the retention prune are measured too. Seed and
// cleanup are timed. Redis/worker throughput is measured by the
// companion script apps/worker/scripts/bench-throughput.ts (same
// safety rails), which needs a Redis URL + the worker queue.
//
// Safety: refuses to run without BENCH_CONFIRM=1, and refuses a
// DATABASE_URL that looks like the production Prisma Postgres host
// unless BENCH_ALLOW_PROD=1 is also set. Point it at a staging or
// local database. Never run against production data.
import { prisma, type Prisma } from "../src/client";

const SIZES = (process.env.BENCH_SIZES ?? "100,1000,10000")
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

// A-WRK-12: prune/stale targets. Old rows sit past the 30-day
// retention window (A-DB-10); stale RUNNING rows sit past the 6h rule.
const OLD_JOB_DAYS = 40;
const STALE_RUNNING_HOURS = 7;
// Audit rows are bounded: 2 per website, first 1000 sites only.
const AUDIT_SEED_WEBSITES = 1000;

async function time(label: string, fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  console.log(`  ${label}: ${ms.toFixed(1)} ms`);
  return ms;
}

async function timeValue<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const value = await fn();
  console.log(`  ${label}: ${(performance.now() - start).toFixed(1)} ms`);
  return value;
}

async function benchSize(size: number) {
  console.log(`\n=== ${size} websites ===`);
  const slug = `bench-scale-${size}-${Date.now()}`;
  const org = await prisma.organization.create({ data: { name: `Bench ${size}`, slug } });
  try {
    const team = await prisma.team.create({ data: { organizationId: org.id, name: "Bench Team", slug: "bench-team" } });
    // A-DB-07: MAPPED integrations must carry their provider's property FK
    // plus its connection (DB CHECKs), so seed one team-level connection and
    // one GA4 property per website. Dummy token — never used for real calls.
    const benchUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        name: "Bench User",
        email: `bench-${size}-${Date.now()}@example.com`,
        role: "SUPER_ADMIN",
      },
    });
    const conn = await prisma.googleConnection.create({
      data: {
        organizationId: org.id,
        ownerType: "TEAM",
        ownerId: team.id,
        teamId: team.id,
        googleAccountEmail: "bench@example.com",
        encryptedRefreshToken: "bench-dummy-token",
        scopes: [],
        status: "ACTIVE",
        createdById: benchUser.id,
      },
    });
    // Seed websites + one MAPPED GA4 integration each, in chunks.
    // A-WRK-12: each chunk also seeds the rows the prune/DLQ/audit/
    // snapshot queries read, so those measurements run against real
    // data instead of empty tables.
    const CHUNK = 500;
    let auditSeeded = 0;
    await time(`seed (${size} websites + integrations + jobs + cache + audit)`, async () => {
      const now = new Date();
      const old = new Date(now.getTime() - OLD_JOB_DAYS * 86_400_000);
      const staleRunningAt = new Date(now.getTime() - STALE_RUNNING_HOURS * 3_600_000);
      for (let i = 0; i < size; i += CHUNK) {
        const batch = Array.from({ length: Math.min(CHUNK, size - i) }, (_, k) => i + k);
        const created = await prisma.website.createManyAndReturn({
          data: batch.map((n) => ({
            organizationId: org.id,
            teamId: team.id,
            name: `Bench Site ${n}`,
            domain: `bench-${n}.example.com`,
            url: `https://bench-${n}.example.com`,
            status: "ACTIVE" as const,
          })),
          select: { id: true },
        });
        const props = await prisma.googleProperty.createManyAndReturn({
          data: batch.map((n) => ({ connectionId: conn.id, propertyId: `properties/${100000000 + i + n}` })),
          select: { id: true, propertyId: true },
        });
        const propIdByExternal = new Map(props.map((p) => [p.propertyId, p.id]));
        await prisma.websiteIntegration.createMany({
          data: created.map((w, k) => ({
            websiteId: w.id,
            provider: "GA4" as const,
            externalId: `properties/${100000000 + i + k}`,
            googleConnectionId: conn.id,
            googlePropertyId: propIdByExternal.get(`properties/${100000000 + i + k}`)!,
            mappingStatus: "MAPPED" as const,
            isPrimary: true,
          })),
        });
        // Sync-job rows: one recent SUCCEEDED per website (so the
        // last-success groupBy measures real data), plus FAILED /
        // RETRYING / old / stale-RUNNING rows at fixed rates.
        const jobs: Prisma.AnalyticsSyncJobCreateManyInput[] = [];
        created.forEach((w, k) => {
          const n = i + k;
          jobs.push({ websiteId: w.id, type: "GA4_HISTORICAL", status: "SUCCEEDED", attempts: 1, lastRunAt: now });
          if (n % 10 === 0) {
            jobs.push({
              websiteId: w.id,
              type: "GA4_HISTORICAL",
              status: "FAILED",
              attempts: 3,
              lastError: "bench simulated failure",
              lastRunAt: now,
            });
          }
          if (n % 20 === 0) {
            jobs.push({ websiteId: w.id, type: "SEARCH_CONSOLE", status: "RETRYING", attempts: 2, lastRunAt: now });
          }
          if (n % 5 === 0) {
            jobs.push({
              websiteId: w.id,
              type: "GA4_HISTORICAL",
              status: "SUCCEEDED",
              attempts: 1,
              lastRunAt: old,
              createdAt: old,
              updatedAt: old,
            });
          }
          if (n % 20 === 5) {
            jobs.push({
              websiteId: w.id,
              type: "ADSENSE",
              status: "FAILED",
              attempts: 5,
              lastError: "bench old failure",
              lastRunAt: old,
              createdAt: old,
              updatedAt: old,
            });
          }
          if (i === 0 && k < 10) {
            jobs.push({
              websiteId: w.id,
              type: "GA4_REALTIME",
              status: "RUNNING",
              attempts: 1,
              lastRunAt: staleRunningAt,
              createdAt: staleRunningAt,
              updatedAt: staleRunningAt,
            });
          }
        });
        if (jobs.length > 0) await prisma.analyticsSyncJob.createMany({ data: jobs });
        // Analytics-cache rows: one snapshot per website, so the
        // readSnapshots-shape query (200 keys) measures real data.
        await prisma.analyticsCache.createMany({
          data: created.map((w) => ({
            cacheKey: `bench:${w.id}:ga4:overview`,
            websiteId: w.id,
            payload: { sessions: 10 },
            expiresAt: new Date(now.getTime() + 3_600_000),
          })),
        });
        // Audit-log rows, bounded to the first 1000 websites (2 each).
        if (auditSeeded < AUDIT_SEED_WEBSITES) {
          const auditWebsites = created.slice(0, AUDIT_SEED_WEBSITES - auditSeeded);
          if (auditWebsites.length > 0) {
            await prisma.auditLog.createMany({
              data: auditWebsites.flatMap((w) => [
                {
                  organizationId: org.id,
                  actorId: benchUser.id,
                  action: "bench.seed",
                  entityType: "Website",
                  entityId: w.id,
                  details: { bench: true },
                },
                {
                  organizationId: org.id,
                  actorId: benchUser.id,
                  action: "bench.sync",
                  entityType: "Website",
                  entityId: w.id,
                  details: { bench: true },
                },
              ]),
            });
            auditSeeded += auditWebsites.length;
          }
        }
      }
    });
    const websiteWhere = { organizationId: org.id };

    // Dashboard query set (Phase 5 bounded shapes).
    await time("website.count", () => prisma.website.count({ where: websiteWhere }));
    await time("website page (50)", () =>
      prisma.website.findMany({
        where: websiteWhere,
        include: { team: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    );
    await time("connected count (relation filter)", () =>
      prisma.website.count({ where: { ...websiteWhere, integrations: { some: { mappingStatus: "MAPPED" } } } }),
    );
    await time("provider groupBy", () =>
      prisma.websiteIntegration.groupBy({ by: ["provider"], where: { website: websiteWhere }, _count: { _all: true } }),
    );
    // A-WRK-12: the last-success groupBy is the production shape
    // (A-WRK-05) — per-page scoped, 500 ids, by website+type. The old
    // unscoped full-table variant is gone: production no longer runs it.
    const pageIds = (await prisma.website.findMany({ where: websiteWhere, select: { id: true }, take: 500 })).map(
      (w) => w.id,
    );
    await time("last-sync groupBy (page ids, 500)", () =>
      prisma.analyticsSyncJob.groupBy({
        by: ["websiteId", "type"],
        where: {
          status: "SUCCEEDED",
          websiteId: { in: pageIds },
          updatedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        _max: { updatedAt: true },
      }),
    );

    // A-PERF-02: the dashboard's own per-page last-sync groupBy
    // (FE-4, by websiteId only — no type) was never measured: the
    // script only had the scheduler's by-[websiteId, type] variant.
    // Dashboard page size is 50, so the first 50 page ids are used.
    await time("dashboard last-sync groupBy (page ids, 50)", () =>
      prisma.analyticsSyncJob.groupBy({
        by: ["websiteId"],
        where: {
          status: "SUCCEEDED",
          websiteId: { in: pageIds.slice(0, 50) },
          updatedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        _max: { updatedAt: true },
      }),
    );

    // Scheduler tick inputs — production shapes (A-WRK-05, A-WRK-09).
    // The tick pages through every site with a cursor; this times one
    // 500-row page.
    await time("scheduler: website page scan (500)", () =>
      prisma.website.findMany({
        where: { status: { in: ["ACTIVE", "PENDING_SETUP"] }, integrations: { some: { mappingStatus: "MAPPED" } } },
        select: { id: true, integrations: { where: { mappingStatus: "MAPPED" }, select: { provider: true } } },
        orderBy: { id: "asc" },
        take: 500,
      }),
    );

    // A-WRK-12: DLQ / audit / snapshot / retention queries, measured
    // against the seeded rows above. The prune shapes are scoped to
    // the scratch org on purpose — the production prune is global, but
    // a benchmark must never delete rows outside its scratch org on a
    // shared staging database.
    const failedWhere = { status: "FAILED" as const, website: websiteWhere };
    await time("sync-job FAILED count (DLQ)", () => prisma.analyticsSyncJob.count({ where: failedWhere }));
    await time("sync-job FAILED page (50, DLQ)", () =>
      prisma.analyticsSyncJob.findMany({
        where: failedWhere,
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: {
          id: true,
          websiteId: true,
          type: true,
          status: true,
          attempts: true,
          lastError: true,
          updatedAt: true,
        },
      }),
    );
    await time("audit-log count (org)", () => prisma.auditLog.count({ where: { organizationId: org.id } }));
    await time("audit-log page (100)", () =>
      prisma.auditLog.findMany({
        where: { organizationId: org.id },
        include: { actor: { select: { email: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    );
    const cacheKeys = pageIds.slice(0, 200).map((id) => `bench:${id}:ga4:overview`);
    await time("cache read by key (200, readSnapshots shape)", () =>
      prisma.analyticsCache.findMany({
        where: { cacheKey: { in: cacheKeys } },
        select: { cacheKey: true, payload: true, expiresAt: true, createdAt: true },
      }),
    );
    const pruneWindowStart = new Date(Date.now() - 30 * 86_400_000);
    const pruneRows = await timeValue("retention prune: old finished job ids (1000)", () =>
      prisma.analyticsSyncJob.findMany({
        where: {
          website: websiteWhere,
          updatedAt: { lt: pruneWindowStart },
          status: { in: ["SUCCEEDED", "FAILED", "PENDING", "RETRYING"] },
        },
        select: { id: true },
        // A-PERF-02: production's pruneInBatches selects ids in id
        // order — the benchmark omitted the orderBy until now.
        orderBy: { id: "asc" },
        take: 1000,
      }),
    );
    console.log(`  retention prune: ${pruneRows.length} old finished job ids found`);
    if (pruneRows.length > 0) {
      await time("retention prune: delete old finished jobs", () =>
        prisma.analyticsSyncJob.deleteMany({ where: { id: { in: pruneRows.map((r) => r.id) } } }),
      );
    }
    await time("stale RUNNING → FAILED (6h rule)", () =>
      prisma.analyticsSyncJob.updateMany({
        where: {
          website: websiteWhere,
          status: "RUNNING",
          updatedAt: { lt: new Date(Date.now() - 6 * 3_600_000) },
        },
        data: { status: "FAILED", lastError: "stale_running" },
      }),
    );
  } finally {
    await time("cleanup: delete scratch org (cascade)", async () => {
      // AuditLog.organization is onDelete: Restrict — the audit rows
      // must go first or the org delete fails and the scratch org
      // leaks behind the swallowed error below.
      await prisma.auditLog.deleteMany({ where: { organizationId: org.id } }).catch(() => undefined);
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
    });
    console.log("  scratch org deleted");
  }
}

async function main() {
  if (process.env.BENCH_CONFIRM !== "1") {
    console.error("Refusing to run: set BENCH_CONFIRM=1 (this seeds and deletes a scratch organization).");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL ?? "";
  if (/prisma\.io/.test(url) && process.env.BENCH_ALLOW_PROD !== "1") {
    console.error(
      "Refusing to run: DATABASE_URL looks like production Prisma Postgres. Use staging/local, or set BENCH_ALLOW_PROD=1 if you really mean it.",
    );
    process.exit(1);
  }
  for (const size of SIZES) await benchSize(size);
  console.log("\nBenchmark complete. Record results in docs/audit/BENCHMARKS.md.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
