// Stage 5 load test (OPS-2 gate): measures scheduler production vs queue
// capacity at 100/500 simulated websites. The planner part runs anywhere;
// the enqueue part runs only when REDIS_URL is set (CI / a real Redis).
// Run: pnpm --filter @metricflock/worker exec tsx scripts/load-test-scheduler.ts
import { planDueSyncs, SYNC_INTERVALS } from "@metricflock/jobs";

const LIMITER_PER_MIN = 20; // ga4-realtime-sync worker limiter

function simulate(sites: number) {
  const websites = Array.from({ length: sites }, (_, i) => ({
    id: `site-${i}`,
    providers: ["GA4", "SEARCH_CONSOLE", "ADSENSE"] as ("GA4" | "SEARCH_CONSOLE" | "ADSENSE")[],
  }));
  const t0 = Date.now();
  const plan = planDueSyncs({ websites, lastSucceededAt: new Map(), now: new Date(), adManagerEnabled: false });
  const planMs = Date.now() - t0;
  const realtime = plan.filter((p) => p.queue === "ga4-realtime-sync");
  const producedPerMin = sites / (SYNC_INTERVALS.ga4RealtimeSeconds / 60);
  console.log(
    `sites=${sites} planMs=${planMs} totalJobs=${plan.length} realtimeJobs=${realtime.length} ` +
      `uniqueRealtimeJobIds=${new Set(realtime.map((p) => p.jobId)).size} ` +
      `realtimeProducedPerMin=${producedPerMin.toFixed(1)} limiterPerMin=${LIMITER_PER_MIN} ` +
      `withinLimiter=${producedPerMin <= LIMITER_PER_MIN} staggerSpread=${new Set(realtime.map((p) => p.delayMs)).size}`,
  );
  return { plan, realtime };
}

async function main() {
  simulate(100);
  simulate(500);
  if (!process.env.REDIS_URL) {
    console.log("REDIS_URL not set — enqueue throughput part skipped (planner numbers above are measured).");
    return;
  }
  const { enqueueBulk, getQueue } = await import("@metricflock/jobs");
  const { realtime } = simulate(500);
  const t0 = Date.now();
  const submitted = await enqueueBulk(
    realtime.map((p) => ({
      name: p.queue,
      data: { websiteId: p.websiteId, loadTest: true },
      jobId: p.jobId,
      delayMs: p.delayMs,
    })),
  );
  console.log(`enqueueBulk: submitted=${submitted} in ${Date.now() - t0}ms`);
  const q = getQueue("ga4-realtime-sync");
  if (q) {
    const counts = await q.getJobCounts("waiting", "delayed", "active");
    console.log(`queue depth after bulk: ${JSON.stringify(counts)} (coalesced: at most 1 pending per website)`);
    await q.obliterate({ force: true });
    await q.close();
  }
  process.exit(0);
}

void main();
