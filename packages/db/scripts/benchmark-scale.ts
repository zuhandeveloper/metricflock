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
// Safety: refuses to run without BENCH_CONFIRM=1, and refuses a
// DATABASE_URL that looks like the production Prisma Postgres host
// unless BENCH_ALLOW_PROD=1 is also set. Point it at a staging or
// local database. Never run against production data.
import { prisma } from "../src/client";

const SIZES = (process.env.BENCH_SIZES ?? "100,1000,10000")
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

async function time(label: string, fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  console.log(`  ${label}: ${ms.toFixed(1)} ms`);
  return ms;
}

async function benchSize(size: number) {
  console.log(`\n=== ${size} websites ===`);
  const slug = `bench-scale-${size}-${Date.now()}`;
  const org = await prisma.organization.create({ data: { name: `Bench ${size}`, slug } });
  try {
    const team = await prisma.team.create({ data: { organizationId: org.id, name: "Bench Team", slug: "bench-team" } });
    // Seed websites + one MAPPED GA4 integration each, in chunks.
    const CHUNK = 500;
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
      await prisma.websiteIntegration.createMany({
        data: created.map((w, k) => ({
          websiteId: w.id,
          provider: "GA4" as const,
          externalId: `properties/${100000000 + i + k}`,
          mappingStatus: "MAPPED" as const,
          isPrimary: true,
        })),
      });
    }
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
    const pageIds = (await prisma.website.findMany({ where: websiteWhere, select: { id: true }, take: 50 })).map(
      (w) => w.id,
    );
    await time("last-sync groupBy (page ids)", () =>
      prisma.analyticsSyncJob.groupBy({
        by: ["websiteId"],
        where: {
          status: "SUCCEEDED",
          websiteId: { in: pageIds },
          updatedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        _max: { updatedAt: true },
      }),
    );

    // Scheduler tick inputs.
    await time("scheduler: last-success groupBy (30d window)", () =>
      prisma.analyticsSyncJob.groupBy({
        by: ["websiteId", "type"],
        where: {
          status: "SUCCEEDED",
          websiteId: { not: null },
          updatedAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        _max: { updatedAt: true },
      }),
    );
    await time("scheduler: website page scan (500)", () =>
      prisma.website.findMany({
        where: { status: "ACTIVE" },
        select: { id: true, integrations: { select: { provider: true }, where: { mappingStatus: "MAPPED" } } },
        take: 500,
      }),
    );
  } finally {
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
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
