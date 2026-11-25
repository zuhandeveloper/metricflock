// Redis/worker throughput benchmark (A-WRK-12): measures BullMQ
// enqueue + drain throughput for the real planned sync jobs of a
// 1k-site portfolio, with a no-op processor — the Redis/BullMQ path,
// not Google API latency.
//
// The jobs run on a SCRATCH queue ("bench-throughput"), never on a
// production queue: a live worker would otherwise consume them and
// attempt real Google syncs against the dummy bench connection. The
// no-op worker mirrors production's concurrency (5); it has NO
// per-queue limiter, so the drain rate is the BullMQ/Redis ceiling,
// not the rate-limited production rate (realtime is limited to
// 20/min in production). The plan itself comes from the real
// `planDueSyncs` planner, so the enqueued job mix is the real one
// for a cold-start tick (everything due).
//
// Usage (from repo root):
//   BENCH_CONFIRM=1 REDIS_URL=<staging redis> DATABASE_URL=<staging db> \
//     pnpm --filter @metricflock/worker exec tsx scripts/bench-throughput.ts
// Optional: BENCH_SIZES=100,1000 to run a subset (default 1000).
//
// Safety: refuses to run without BENCH_CONFIRM=1; refuses the
// production Redis host unless BENCH_ALLOW_PROD=1 is also set, and
// refuses a DATABASE_URL that looks like production Prisma Postgres
// unless BENCH_ALLOW_PROD=1 is set. The scratch queue is obliterated
// afterwards and the scratch org is deleted (cascade). REDIS_URL is
// never printed.
import { Queue, Worker } from "bullmq";
import { prisma } from "@metricflock/db";
import { planDueSyncs, type SyncProviderName } from "@metricflock/jobs";
import { bullConnectionOptions } from "@metricflock/shared";

const BENCH_QUEUE = "bench-throughput";
const PROD_REDIS_HOST = "neopure-tin-desk-16492.db.redis.io";
const DRAIN_TIMEOUT_MS = 5 * 60_000;
const WORKER_CONCURRENCY = 5; // same as the production workers
const ENQUEUE_CHUNK = 1000;

const SIZES = (process.env.BENCH_SIZES ?? "1000")
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

async function benchSize(size: number) {
  console.log(`\n=== ${size} websites (throughput) ===`);
  const slug = `bench-throughput-${size}-${Date.now()}`;
  const org = await prisma.organization.create({ data: { name: `Bench Throughput ${size}`, slug } });
  try {
    const team = await prisma.team.create({ data: { organizationId: org.id, name: "Bench Team", slug: "bench-team" } });
    // A-DB-07: same seeding shape as benchmark-scale.ts — one
    // team-level connection and one MAPPED GA4 property per website.
    // Dummy token — never used for real calls.
    const benchUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        name: "Bench User",
        email: `bench-throughput-${size}-${Date.now()}@example.com`,
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
    const CHUNK = 500;
    const websiteIds: string[] = [];
    const seedStart = performance.now();
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
      websiteIds.push(...created.map((w) => w.id));
    }
    console.log(`  seed (${size} websites + integrations): ${(performance.now() - seedStart).toFixed(1)} ms`);

    // Plan with the real planner — an empty last-success map means
    // everything is due, i.e. a cold-start tick.
    const planStart = performance.now();
    const plan = planDueSyncs({
      websites: websiteIds.map((id) => ({ id, providers: ["GA4" as SyncProviderName] })),
      lastSucceededAt: new Map(),
      now: new Date(),
      adManagerEnabled: false,
    });
    console.log(`  planDueSyncs: ${(performance.now() - planStart).toFixed(1)} ms (${plan.length} jobs)`);
    const perQueue = new Map<string, number>();
    for (const p of plan) perQueue.set(p.queue, (perQueue.get(p.queue) ?? 0) + 1);
    console.log(`  planned per queue: ${JSON.stringify(Object.fromEntries(perQueue))}`);
    if (plan.length === 0) {
      console.log("  no jobs planned — nothing to enqueue or drain.");
      return;
    }

    const connection = bullConnectionOptions();
    if (!connection) {
      console.error("Refusing to run: bullConnectionOptions() returned null (REDIS_URL unset or invalid).");
      process.exit(1);
    }
    const queue = new Queue(BENCH_QUEUE, { connection });
    const enqueueStart = performance.now();
    for (let i = 0; i < plan.length; i += ENQUEUE_CHUNK) {
      await queue.addBulk(
        plan.slice(i, i + ENQUEUE_CHUNK).map((p) => ({
          name: BENCH_QUEUE,
          // The planned jobId is kept (unique: it embeds the original
          // queue + website + interval bucket). data carries the
          // original queue so the mix stays visible in the job rows.
          data: { websiteId: p.websiteId, queue: p.queue, bench: true },
          opts: {
            jobId: p.jobId,
            attempts: 5,
            backoff: { type: "custom" as const },
            priority: 10,
            removeOnComplete: 100,
            removeOnFail: 500,
          },
        })),
      );
    }
    const enqueueMs = performance.now() - enqueueStart;
    console.log(
      `  enqueueBulk: ${plan.length} jobs in ${enqueueMs.toFixed(1)} ms (${((plan.length / enqueueMs) * 1000).toFixed(0)} jobs/s)`,
    );
    const depth = await queue.getJobCounts("waiting", "delayed");
    console.log(`  queue depth after enqueue: ${JSON.stringify(depth)}`);

    // Drain with a no-op worker (same concurrency as production).
    let completed = 0;
    let failed = 0;
    const worker = new Worker(
      BENCH_QUEUE,
      async () => {
        completed += 1;
      },
      { connection, concurrency: WORKER_CONCURRENCY },
    );
    worker.on("failed", () => {
      failed += 1;
    });
    const drainStart = performance.now();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.log(`  drain timed out after ${DRAIN_TIMEOUT_MS / 1000}s (${completed}/${plan.length} completed)`);
        resolve();
      }, DRAIN_TIMEOUT_MS);
      const iv = setInterval(() => {
        if (completed + failed >= plan.length) {
          clearTimeout(timer);
          clearInterval(iv);
          resolve();
        }
      }, 100);
    });
    const drainMs = performance.now() - drainStart;
    console.log(
      `  drain: ${completed} completed, ${failed} failed in ${(drainMs / 1000).toFixed(1)}s (${((completed / drainMs) * 60_000).toFixed(0)} jobs/min)`,
    );
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  } finally {
    const cleanupStart = performance.now();
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
    console.log(`  cleanup: delete scratch org (cascade): ${(performance.now() - cleanupStart).toFixed(1)} ms`);
  }
}

async function main() {
  if (process.env.BENCH_CONFIRM !== "1") {
    console.error("Refusing to run: set BENCH_CONFIRM=1 (this seeds a scratch organization and a scratch queue).");
    process.exit(1);
  }
  const redisUrl = process.env.REDIS_URL ?? "";
  if (!redisUrl) {
    console.error("Refusing to run: REDIS_URL is required (throughput needs a Redis).");
    process.exit(1);
  }
  let redisHost = "";
  try {
    redisHost = new URL(redisUrl).hostname;
  } catch {
    // Unparseable URL: bullConnectionOptions() will fail below; do not
    // print the URL (it may contain credentials).
    console.error("Refusing to run: REDIS_URL is not a valid URL.");
    process.exit(1);
  }
  if (redisHost === PROD_REDIS_HOST && process.env.BENCH_ALLOW_PROD !== "1") {
    console.error(
      "Refusing to run: REDIS_URL looks like the production Redis host. Use staging/local, or set BENCH_ALLOW_PROD=1 if you really mean it.",
    );
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (/prisma\.io/.test(dbUrl) && process.env.BENCH_ALLOW_PROD !== "1") {
    console.error(
      "Refusing to run: DATABASE_URL looks like production Prisma Postgres. Use staging/local, or set BENCH_ALLOW_PROD=1 if you really mean it.",
    );
    process.exit(1);
  }
  for (const size of SIZES) await benchSize(size);
  console.log("\nThroughput benchmark complete. Record results in docs/audit/BENCHMARKS.md.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
