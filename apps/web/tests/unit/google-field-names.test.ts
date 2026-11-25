import { describe, it, expect, beforeEach, vi } from "vitest";

// Live-discovered 2026-11-24 (Railway worker against the real Google
// APIs): the GA4 + AdSense jobs failed on field names that do not exist in
// the providers' schemas, while Search Console syncs succeeded — so auth,
// tokens and worker infra were fine and the names were the whole fault.
// These tests pin the corrected names against the documented schemas so a
// wrong name can never regress silently again:
//
// - AdSense Management API v2 Metric enum
//   (https://developers.google.com/adsense/management/reference/rest/v2/Metric):
//   no CTR / CPC / PAGE_RPM / IMPRESSION_RPM — the valid names are
//   IMPRESSIONS_CTR, COST_PER_CLICK, PAGE_VIEWS_RPM, IMPRESSIONS_RPM.
// - GA4 Data API v1 metrics
//   (https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema):
//   no averageEngagementTime / averageEngagementTimePerSession — Google's
//   predefined-reports queries define the averageEngagementTime column as
//   the metric expression userEngagementDuration/activeUsers
//   (https://developers.google.com/analytics/devguides/reporting/data/v1/predefined-reports).
// - GA4 Realtime API schema
//   (https://developers.google.com/analytics/devguides/reporting/data/v1/realtime-api-schema):
//   15 valid dimensions; browser / operatingSystem / unifiedPagePathScreen
//   are core-reporting-only.
const mocks = vi.hoisted(() => ({
  runReport: vi.fn(),
  runRealtimeReport: vi.fn(),
  adsenseGenerate: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    analyticsdata: () => ({
      properties: { runReport: mocks.runReport, runRealtimeReport: mocks.runRealtimeReport },
    }),
    adsense: () => ({ accounts: { reports: { generate: mocks.adsenseGenerate } } }),
  },
}));

import {
  getGa4Client,
  runHistoricalReport,
  runPagesReport,
  runRealtimeReport,
  GA4_CORE_METRICS,
  REALTIME_BREAKDOWN_DIMENSIONS,
  AVERAGE_ENGAGEMENT_TIME,
  ga4MetricName,
} from "@metricflock/google/ga4";
import { runAdSenseReport, ADSENSE_API_METRICS } from "@metricflock/google/adsense";

const auth = {} as never;

// The full AdSense Management API v2 Metric enum (abridged to the names
// this repo may ever request — the point is that the old names are absent).
const ADSENSE_VALID_METRICS = new Set([
  "ESTIMATED_EARNINGS",
  "TOTAL_EARNINGS",
  "PAGE_VIEWS",
  "IMPRESSIONS",
  "TOTAL_IMPRESSIONS",
  "CLICKS",
  "AD_REQUESTS",
  "PAGE_VIEWS_CTR",
  "AD_REQUESTS_CTR",
  "IMPRESSIONS_CTR",
  "COST_PER_CLICK",
  "PAGE_VIEWS_RPM",
  "AD_REQUESTS_RPM",
  "IMPRESSIONS_RPM",
]);

// The 15 dimensions the Realtime API schema allows (see header comment).
const REALTIME_VALID_DIMENSIONS = new Set([
  "appVersion",
  "audienceId",
  "audienceName",
  "audienceResourceName",
  "city",
  "cityId",
  "country",
  "countryId",
  "deviceCategory",
  "eventName",
  "minutesAgo",
  "platform",
  "streamId",
  "streamName",
  "unifiedScreenName",
]);

describe("Google API field names (live-discovered 2026-11-24)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AdSense requests only valid v2 metric names", async () => {
    mocks.adsenseGenerate.mockResolvedValue({ data: { headers: [], rows: [], totals: null } });
    await runAdSenseReport(auth, "pub-1", "2026-11-01", "2026-11-02");
    const requested = mocks.adsenseGenerate.mock.calls[0][0].metrics as string[];
    expect(requested).toEqual([...ADSENSE_API_METRICS]);
    for (const m of requested) expect(ADSENSE_VALID_METRICS.has(m), m).toBe(true);
    for (const bad of ["CTR", "CPC", "PAGE_RPM", "IMPRESSION_RPM"]) {
      expect(requested, bad).not.toContain(bad);
    }
  });

  it("AdSense maps v2 response headers back to the internal canonical keys", async () => {
    mocks.adsenseGenerate.mockResolvedValue({
      data: {
        headers: [
          { name: "DATE" },
          { name: "ESTIMATED_EARNINGS" },
          { name: "IMPRESSIONS_CTR" },
          { name: "COST_PER_CLICK" },
          { name: "PAGE_VIEWS_RPM" },
          { name: "IMPRESSIONS_RPM" },
        ],
        rows: [
          {
            cells: [
              { value: "2026-11-01" },
              { value: "12.34" },
              { value: "0.02" },
              { value: "0.5" },
              { value: "8" },
              { value: "6" },
            ],
          },
        ],
        totals: {
          cells: [
            { value: "" },
            { value: "12.34" },
            { value: "0.02" },
            { value: "0.5" },
            { value: "8" },
            { value: "6" },
          ],
        },
      },
    });
    const out = await runAdSenseReport(auth, "pub-1", "2026-11-01", "2026-11-02");
    expect(out.headers).toEqual(["DATE", "ESTIMATED_EARNINGS", "CTR", "CPC", "PAGE_RPM", "IMPRESSION_RPM"]);
    expect(out.rows[0]).toEqual({
      DATE: "2026-11-01",
      ESTIMATED_EARNINGS: 12.34,
      CTR: 0.02,
      CPC: 0.5,
      PAGE_RPM: 8,
      IMPRESSION_RPM: 6,
    });
    expect(out.totalsByMetric).toEqual({
      DATE: "",
      ESTIMATED_EARNINGS: 12.34,
      CTR: 0.02,
      CPC: 0.5,
      PAGE_RPM: 8,
      IMPRESSION_RPM: 6,
    });
  });

  it("GA4 core metrics fit the 10-metric runReport cap and define average engagement time as an expression", () => {
    expect(GA4_CORE_METRICS.length).toBeLessThanOrEqual(10);
    expect(AVERAGE_ENGAGEMENT_TIME).toEqual({
      name: "averageEngagementTime",
      expression: "userEngagementDuration/activeUsers",
    });
    expect(GA4_CORE_METRICS).toContainEqual(AVERAGE_ENGAGEMENT_TIME);
    const names = GA4_CORE_METRICS.map(ga4MetricName);
    expect(names).not.toContain("averageEngagementTimePerSession");
    // No bare string entry: the name is only valid as the expression alias.
    expect(GA4_CORE_METRICS.filter((m) => m === "averageEngagementTime")).toEqual([]);
  });

  it("GA4 historical report sends the expression and keys the summary by the alias", async () => {
    mocks.runReport.mockResolvedValue({
      data: {
        totals: [
          {
            metricValues: [
              { value: "100" },
              { value: "80" },
              { value: "50" },
              { value: "40" },
              { value: "30" },
              { value: "20" },
              { value: "0.5" },
              { value: "90" },
              { value: "7" },
              { value: "3" },
            ],
          },
        ],
        rows: [],
        rowCount: 0,
        metadata: {},
      },
    });
    const out = await runHistoricalReport(getGa4Client(auth), "123", "2026-11-01", "2026-11-02");
    const sent = mocks.runReport.mock.calls[0][0].requestBody.metrics as unknown[];
    expect(sent).toHaveLength(10);
    expect(sent).toContainEqual({ name: "averageEngagementTime", expression: "userEngagementDuration/activeUsers" });
    expect(out.summary).toEqual({
      totalUsers: 100,
      activeUsers: 80,
      newUsers: 50,
      sessions: 40,
      screenPageViews: 30,
      engagedSessions: 20,
      engagementRate: 0.5,
      averageEngagementTime: 90,
      eventCount: 7,
      keyEvents: 3,
    });
    expect(out.summary).not.toHaveProperty("averageEngagementTimePerSession");
  });

  it("GA4 pages report requests the expression metric, not the bare name", async () => {
    mocks.runReport.mockResolvedValue({ data: { totals: [], rows: [], rowCount: 0, metadata: {} } });
    await runPagesReport(getGa4Client(auth), "123", "2026-11-01", "2026-11-02");
    const sent = mocks.runReport.mock.calls[0][0].requestBody.metrics as unknown[];
    expect(sent).toContainEqual({ name: "averageEngagementTime", expression: "userEngagementDuration/activeUsers" });
    expect(sent).not.toContainEqual({ name: "averageEngagementTime" });
  });

  it("realtime breakdown dimensions are all in the Realtime API schema", () => {
    for (const d of REALTIME_BREAKDOWN_DIMENSIONS) {
      expect(REALTIME_VALID_DIMENSIONS.has(d), d).toBe(true);
    }
    for (const bad of ["browser", "operatingSystem", "unifiedPagePathScreen"]) {
      expect(REALTIME_BREAKDOWN_DIMENSIONS as readonly string[], bad).not.toContain(bad);
    }
  });

  it("realtime report queries only valid dimensions and drops the OS/browser breakdowns", async () => {
    mocks.runRealtimeReport.mockImplementation(() =>
      // Totals query is dimension-less; breakdowns carry one dimension.
      Promise.resolve({ data: { rows: [{ metricValues: [{ value: "5" }, { value: "9" }] }], rowCount: 1 } }),
    );
    const out = await runRealtimeReport(getGa4Client(auth), "123");
    for (const call of mocks.runRealtimeReport.mock.calls) {
      const dims = (call[0] as { requestBody?: { dimensions?: { name: string }[] } }).requestBody?.dimensions ?? [];
      for (const d of dims) expect(REALTIME_VALID_DIMENSIONS.has(d.name), d.name).toBe(true);
    }
    expect(out).toHaveProperty("byCountry");
    expect(out).toHaveProperty("byCity");
    expect(out).toHaveProperty("byDevice");
    expect(out).toHaveProperty("byPlatform");
    expect(out).toHaveProperty("byPage");
    expect(out).not.toHaveProperty("byBrowser");
    expect(out).not.toHaveProperty("byOperatingSystem");
    // A-GGL-16: all queries succeeded, so no partial flag.
    expect(out).not.toHaveProperty("partial");
  });

  it("one failing breakdown does not lose the totals or the other breakdowns (A-GGL-16)", async () => {
    mocks.runRealtimeReport.mockImplementation((req: { requestBody?: { dimensions?: { name: string }[] } }) => {
      const dim = req.requestBody?.dimensions?.[0]?.name;
      if (dim === "city") {
        // e.g. a dimension Google rejects for this property.
        return Promise.reject(new Error("INVALID_ARGUMENT: city is not valid for this property"));
      }
      if (!dim) {
        // Dimension-less totals query.
        return Promise.resolve({ data: { rows: [{ metricValues: [{ value: "7" }, { value: "11" }] }], rowCount: 1 } });
      }
      return Promise.resolve({
        data: { rows: [{ dimensionValues: [{ value: `${dim}-value` }], metricValues: [{ value: "3" }] }], rowCount: 1 },
      });
    });
    const out = await runRealtimeReport(getGa4Client(auth), "123");
    // Totals survive.
    expect(out.activeUsers).toBe(7);
    expect(out.eventCount).toBe(11);
    // The other breakdowns survive with their rows.
    expect(out.byCountry).toEqual([{ name: "country-value", activeUsers: 3 }]);
    expect(out.byDevice).toEqual([{ name: "deviceCategory-value", activeUsers: 3 }]);
    expect(out.byPlatform).toEqual([{ name: "platform-value", activeUsers: 3 }]);
    expect(out.byPage).toEqual([{ name: "unifiedScreenName-value", activeUsers: 3 }]);
    // The failed breakdown is empty and named in the partial flag.
    expect(out.byCity).toEqual([]);
    expect(out.partial).toEqual(["city"]);
  });
});
