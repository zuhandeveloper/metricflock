import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { counterSnapshot } from "@metricflock/shared";
import { getQueue, QUEUE_NAMES } from "@metricflock/jobs";

// Operational metrics (Stage 8). SUPER_ADMIN only — queue depths and
// failure counts are internal operational data, not public. In-process
// counters (cache/provider/api) reset on restart; the durable numbers
// (sync success, DLQ depth) come from AnalyticsSyncJob rows.
export async function GET(_req: NextRequest) {
  const auth = await requireApiAuth();
  if ("error" in auth) return auth.error;
  if (auth.user.role !== "SUPER_ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const counters = counterSnapshot();
  const hits = counters["cache.hit"] ?? 0;
  const staleHits = counters["cache.stale_hit"] ?? 0;
  const misses = counters["cache.miss"] ?? 0;
  const lookups = hits + staleHits + misses;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [byStatus, oldestFailed] = await Promise.all([
    prisma.analyticsSyncJob.groupBy({
      by: ["status"],
      where: { updatedAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.analyticsSyncJob.findFirst({
      where: { status: "FAILED" },
      orderBy: { updatedAt: "asc" },
      select: { updatedAt: true },
    }),
  ]);
  const statusCounts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
  const succeeded = statusCounts["SUCCEEDED"] ?? 0;
  const failed = statusCounts["FAILED"] ?? 0;
  const finished = succeeded + failed;

  const queues: Record<string, unknown> = {};
  for (const name of QUEUE_NAMES) {
    const q = getQueue(name);
    if (!q) {
      queues[name] = { disabled: true };
      continue;
    }
    try {
      queues[name] = await q.getJobCounts("waiting", "delayed", "active", "failed");
    } catch {
      queues[name] = { error: "unavailable" };
    }
  }

  return NextResponse.json({
    ts: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    counters,
    cache: {
      hits,
      staleHits,
      misses,
      hitRate: lookups > 0 ? Number(((hits + staleHits) / lookups).toFixed(4)) : null,
    },
    sync24h: {
      byStatus: statusCounts,
      successRate: finished > 0 ? Number((succeeded / finished).toFixed(4)) : null,
    },
    dlq: {
      failed24h: failed,
      oldestFailedAt: oldestFailed?.updatedAt.toISOString() ?? null,
    },
    queues,
  });
}
