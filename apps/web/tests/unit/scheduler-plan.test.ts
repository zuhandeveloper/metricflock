import { describe, it, expect } from "vitest";
import { planDueSyncs, SYNC_TYPE_BY_QUEUE, SYNC_TYPE_BY_REPORT } from "@metricflock/jobs";

const NOW = new Date("2026-11-19T12:00:00Z");
const VALID_SYNC_TYPES = [
  "OAUTH_REFRESH",
  "PROPERTY_DISCOVERY",
  "GA4_REALTIME",
  "GA4_HISTORICAL",
  "SEARCH_CONSOLE",
  "ADSENSE",
  "AD_MANAGER",
  "CACHE_REFRESH",
  "HEALTH_CHECK",
];

describe("scheduler due-plan", () => {
  it("every queue maps to a valid Prisma SyncJobType enum value", () => {
    for (const value of Object.values(SYNC_TYPE_BY_QUEUE)) expect(VALID_SYNC_TYPES).toContain(value);
    expect(SYNC_TYPE_BY_REPORT.overview).toBe("GA4_HISTORICAL");
    expect(SYNC_TYPE_BY_REPORT.realtime).toBe("GA4_REALTIME");
    expect(SYNC_TYPE_BY_REPORT["search-console"]).toBe("SEARCH_CONSOLE");
  });

  it("never-synced website is due for all its provider queues", () => {
    const plan = planDueSyncs({
      websites: [{ id: "site-1", providers: ["GA4", "SEARCH_CONSOLE", "ADSENSE"] }],
      lastSucceededAt: new Map(),
      now: NOW,
      adManagerEnabled: false,
    });
    expect(plan.map((p) => p.queue).sort()).toEqual([
      "adsense-sync",
      "ga4-historical-sync",
      "ga4-realtime-sync",
      "integration-health-check",
      "search-console-sync",
    ]);
    expect(plan.every((p) => p.jobId.startsWith(`${p.queue}:site-1:`))).toBe(true);
  });

  it("recently synced queues are not due; stale ones are", () => {
    const last = new Map<string, Date | null>([
      ["site-1:GA4_REALTIME", new Date(NOW.getTime() - 10_000)], // 10s ago, interval 30s -> not due
      ["site-1:GA4_HISTORICAL", new Date(NOW.getTime() - 50 * 60_000)], // 50m ago, interval 45m -> due
      ["site-1:SEARCH_CONSOLE", new Date(NOW.getTime() - 2 * 3_600_000)], // 2h ago, interval 8h -> not due
      ["site-1:HEALTH_CHECK", new Date(NOW.getTime() - 30 * 60_000)], // 30m ago, interval 1h -> not due
    ]);
    const plan = planDueSyncs({
      websites: [{ id: "site-1", providers: ["GA4", "SEARCH_CONSOLE"] }],
      lastSucceededAt: last,
      now: NOW,
      adManagerEnabled: false,
    });
    expect(plan.map((p) => p.queue)).toEqual(["ga4-historical-sync"]);
  });

  it("Ad Manager queue only when enabled; no providers -> no jobs", () => {
    const off = planDueSyncs({
      websites: [{ id: "s", providers: ["AD_MANAGER"] }],
      lastSucceededAt: new Map(),
      now: NOW,
      adManagerEnabled: false,
    });
    expect(off.map((p) => p.queue)).toEqual(["integration-health-check"]);
    const on = planDueSyncs({
      websites: [{ id: "s", providers: ["AD_MANAGER"] }],
      lastSucceededAt: new Map(),
      now: NOW,
      adManagerEnabled: true,
    });
    expect(on.map((p) => p.queue).sort()).toEqual(["ad-manager-sync", "integration-health-check"]);
    const none = planDueSyncs({
      websites: [{ id: "s", providers: [] }],
      lastSucceededAt: new Map(),
      now: NOW,
      adManagerEnabled: true,
    });
    expect(none).toEqual([]);
  });

  it("jobIds are stable within an interval bucket (dedup)", () => {
    const input = {
      websites: [{ id: "site-1", providers: ["GA4" as const] }],
      lastSucceededAt: new Map(),
      adManagerEnabled: false,
    };
    const a = planDueSyncs({ ...input, now: new Date("2026-11-19T12:00:00Z") });
    const b = planDueSyncs({ ...input, now: new Date("2026-11-19T12:01:00Z") });
    const histA = a.find((p) => p.queue === "ga4-historical-sync")!;
    const histB = b.find((p) => p.queue === "ga4-historical-sync")!;
    expect(histA.jobId).toBe(histB.jobId);
  });
});
