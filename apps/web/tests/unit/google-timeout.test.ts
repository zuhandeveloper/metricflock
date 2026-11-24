import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A-GGL-03: every googleapis call is bounded. A provider that never
// responds must fail fast with GOOGLE_API_TIMEOUT (classified
// temporarily_unavailable), not hang the request. The timeout is
// shortened via GOOGLE_API_TIMEOUT_MS for these tests — the production
// value (15 s) is the shared constant in @metricflock/google/timeout.
const mocks = vi.hoisted(() => ({
  runReport: vi.fn(),
  runRealtimeReport: vi.fn(),
  scQuery: vi.fn(),
  adsenseGenerate: vi.fn(),
  accountsList: vi.fn(),
  propertiesList: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    analyticsdata: () => ({
      properties: { runReport: mocks.runReport, runRealtimeReport: mocks.runRealtimeReport },
    }),
    searchconsole: () => ({ searchanalytics: { query: mocks.scQuery } }),
    adsense: () => ({ accounts: { reports: { generate: mocks.adsenseGenerate } } }),
    analyticsadmin: () => ({
      accounts: { list: mocks.accountsList },
      properties: { list: mocks.propertiesList },
    }),
  },
}));

// classifyAnalyticsError lives in the handler; mock its heavy deps so the
// import stays light (the classifier itself is pure).
vi.mock("@metricflock/auth", () => ({ requireApiAuth: vi.fn(), assertWebsiteAccess: vi.fn() }));
vi.mock("@metricflock/google/client", () => ({
  getAuthorizedClientForIntegration: vi.fn(),
  getPrimaryIntegration: vi.fn(),
  resolveConnectionForWebsite: vi.fn(),
}));
vi.mock("@metricflock/db/health", () => ({ lastSuccessfulSync: vi.fn() }));
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshot: vi.fn(), writeSnapshot: vi.fn() }));
vi.mock("@metricflock/jobs", () => ({ SYNC_TYPE_BY_REPORT: {}, snapshotTtlSeconds: () => 300 }));

import { getGa4Client, runHistoricalReport, runRealtimeReport } from "@metricflock/google/ga4";
import { querySearchAnalytics } from "@metricflock/google/search-console";
import { runAdSenseReport } from "@metricflock/google/adsense";
import { listGa4Properties } from "@metricflock/google/discovery";
import { classifyAnalyticsError } from "@/lib/analytics-handler";

const never = () => new Promise<never>(() => {});
const auth = {} as never;

describe("googleapis timeouts (A-GGL-03)", () => {
  const savedTimeout = process.env.GOOGLE_API_TIMEOUT_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_API_TIMEOUT_MS = "50";
  });
  afterEach(() => {
    if (savedTimeout === undefined) delete process.env.GOOGLE_API_TIMEOUT_MS;
    else process.env.GOOGLE_API_TIMEOUT_MS = savedTimeout;
  });

  it("GA4 historical report fails fast when the provider never responds", async () => {
    mocks.runReport.mockImplementation(never);
    const start = Date.now();
    await expect(runHistoricalReport(getGa4Client(auth), "123", "2026-11-01", "2026-11-02")).rejects.toThrow(
      "GOOGLE_API_TIMEOUT",
    );
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("GA4 realtime report fails fast when the provider never responds", async () => {
    mocks.runRealtimeReport.mockImplementation(never);
    await expect(runRealtimeReport(getGa4Client(auth), "123")).rejects.toThrow("GOOGLE_API_TIMEOUT");
  });

  it("Search Console query fails fast when the provider never responds", async () => {
    mocks.scQuery.mockImplementation(never);
    await expect(querySearchAnalytics(auth, "https://example.com/", "2026-11-01", "2026-11-02")).rejects.toThrow(
      "GOOGLE_API_TIMEOUT",
    );
  });

  it("AdSense report fails fast when the provider never responds", async () => {
    mocks.adsenseGenerate.mockImplementation(never);
    await expect(runAdSenseReport(auth, "pub-1", "2026-11-01", "2026-11-02")).rejects.toThrow("GOOGLE_API_TIMEOUT");
  });

  it("GA4 discovery fails fast when the provider never responds", async () => {
    mocks.accountsList.mockImplementation(never);
    await expect(listGa4Properties(auth)).rejects.toThrow("GOOGLE_API_TIMEOUT");
  });

  it("classifies timeouts as temporarily_unavailable", () => {
    expect(classifyAnalyticsError(new Error("GOOGLE_API_TIMEOUT: ga4.runReport did not respond within 50ms"))).toBe(
      "temporarily_unavailable",
    );
    const aborted = new Error("The operation was aborted") as Error & { name: string };
    aborted.name = "AbortError";
    expect(classifyAnalyticsError(aborted)).toBe("temporarily_unavailable");
    // Non-timeout errors keep their existing classification.
    expect(classifyAnalyticsError(new Error("SCOPE_MISSING"))).toBe("scope_missing");
  });

  it("every analytics route exports maxDuration", () => {
    const dir = path.resolve(process.cwd(), "src/app/api/analytics");
    const routes = [
      "ad-manager",
      "adsense",
      "audience",
      "events",
      "overview",
      "pages",
      "realtime",
      "search-console",
      "traffic",
    ];
    for (const route of routes) {
      const text = fs.readFileSync(path.join(dir, route, "route.ts"), "utf8");
      expect(text, `${route}/route.ts`).toContain("export const maxDuration = 60;");
    }
  });
});
