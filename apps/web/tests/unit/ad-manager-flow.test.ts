import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseAdManagerReport, runAdManagerReport } from "@metricflock/google/ad-manager";

// A-GGL-01: the real v1 flow — create report → run existing report → poll
// the Operation → fetchRows — against recorded (fixture) responses shaped
// exactly like Google's own published examples
// (developers.google.com/ad-manager/api/beta/reports). No live account
// is involved; live verification against a real network is still pending.
const auth = { getAccessToken: async () => ({ token: "tok" }) } as never;

type Call = { url: string; init: RequestInit | undefined };
function fetchStub(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return { ok: true, status: 200, json: async () => handler(call) };
    }),
  );
  return calls;
}

const OP_NAME = "networks/123/operations/reports/runs/648";
const REPORT_NAME = "networks/123/reports/455";
const RESULT_NAME = "networks/123/reports/455/results/703";

const PAGE_1_ROWS = [
  {
    dimensionValues: [{ stringValue: "2026-11-01" }, { stringValue: "Homepage" }],
    metricValueGroups: [
      {
        primaryValues: [{ intValue: "1000" }, { intValue: "25" }, { doubleValue: 0.025 }, { microsValue: "12500000" }],
      },
    ],
  },
];
const PAGE_2_ROWS = [
  {
    dimensionValues: [{ stringValue: "2026-11-02" }, { stringValue: "Homepage" }],
    metricValueGroups: [
      {
        primaryValues: [{ intValue: "500" }, { intValue: "10" }, { doubleValue: 0.02 }, { microsValue: "6250000" }],
      },
    ],
  },
];

describe("Ad Manager v1 report flow (A-GGL-01)", () => {
  beforeEach(() => {
    process.env.GOOGLE_AD_MANAGER_ENABLED = "true";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
  });

  it("runs create → run → poll → fetchRows and returns parsed rows + totals", async () => {
    let polls = 0;
    const calls = fetchStub(({ url }) => {
      if (url.endsWith("/networks/123/reports")) return { name: REPORT_NAME, reportId: "455" };
      if (url.endsWith(`/${REPORT_NAME}:run`)) return { name: OP_NAME, done: false };
      if (url.endsWith(`/${OP_NAME}`)) {
        polls++;
        if (polls === 1) return { name: OP_NAME, done: false, metadata: { percentComplete: 50 } };
        return {
          name: OP_NAME,
          done: true,
          response: {
            "@type": "type.googleapis.com/google.ads.admanager.v1.RunReportResponse",
            reportResult: RESULT_NAME,
          },
        };
      }
      if (url.includes(`${RESULT_NAME}:fetchRows`)) {
        if (url.includes("pageToken=tok2")) return { rows: PAGE_2_ROWS, totalRowCount: 2 };
        return { rows: PAGE_1_ROWS, totalRowCount: 2, nextPageToken: "tok2" };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const out = await runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", {
      pollTimeoutMs: 5000,
      pollIntervalMs: 5,
    });

    // 1. create posted a ReportDefinition with a fixed date range.
    const create = calls.find((c) => c.url.endsWith("/networks/123/reports"))!;
    const createBody = JSON.parse(String(create.init?.body));
    expect(createBody).toEqual({
      report: {
        displayName: "MetricFlock 2026-11-01 to 2026-11-02",
        reportDefinition: {
          dimensions: ["DATE", "AD_UNIT_NAME"],
          metrics: ["AD_SERVER_IMPRESSIONS", "AD_SERVER_CLICKS", "AD_SERVER_CTR", "TOTAL_REVENUE"],
          dateRange: {
            fixed: {
              startDate: { year: 2026, month: 11, day: 1 },
              endDate: { year: 2026, month: 11, day: 2 },
            },
          },
          reportType: "HISTORICAL",
        },
      },
    });
    // 2. run was called on the created report's resource name, not on a
    // fabricated `reports:run` endpoint with an inline definition.
    expect(calls.some((c) => c.url.endsWith(`/${REPORT_NAME}:run`))).toBe(true);
    expect(calls.some((c) => c.url.includes("reports:run"))).toBe(false);
    // 3. the Operation was polled until done, then rows fetched (2 pages).
    expect(polls).toBe(2);
    expect(calls.filter((c) => c.url.includes(":fetchRows")).length).toBe(2);
    // 4. rows parsed from the real fetchRows shape, micros → dollars.
    expect(out.parsed).toBe(true);
    expect(out.rows).toEqual([
      { dimensions: ["2026-11-01", "Homepage"], metrics: [1000, 25, 0.025, 12.5] },
      { dimensions: ["2026-11-02", "Homepage"], metrics: [500, 10, 0.02, 6.25] },
    ]);
    expect(out.totals).toEqual({
      AD_SERVER_IMPRESSIONS: 1500,
      AD_SERVER_CLICKS: 35,
      AD_SERVER_CTR: 35 / 1500,
      TOTAL_REVENUE: 18.75,
    });
    expect(out.totalRowCount).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it("fails loudly when the Operation completes with an error", async () => {
    fetchStub(({ url }) => {
      if (url.endsWith("/networks/123/reports")) return { name: REPORT_NAME, reportId: "455" };
      if (url.endsWith(`/${REPORT_NAME}:run`)) {
        return {
          name: OP_NAME,
          done: true,
          error: { code: 403, status: "PERMISSION_DENIED", message: "caller lacks reports permission" },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(
      runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", { pollTimeoutMs: 1000, pollIntervalMs: 5 }),
    ).rejects.toThrow("AD_MANAGER_REPORT_FAILED");
  });

  it("times out while polling instead of hanging", async () => {
    fetchStub(({ url }) => {
      if (url.endsWith("/networks/123/reports")) return { name: REPORT_NAME, reportId: "455" };
      if (url.endsWith(`/${REPORT_NAME}:run`)) return { name: OP_NAME, done: false };
      if (url.endsWith(`/${OP_NAME}`)) return { name: OP_NAME, done: false };
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(
      runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", { pollTimeoutMs: 50, pollIntervalMs: 5 }),
    ).rejects.toThrow("AD_MANAGER_REPORT_TIMEOUT");
  });

  it("fails loudly when create returns no report name", async () => {
    fetchStub(() => ({}));
    await expect(
      runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", { pollTimeoutMs: 1000, pollIntervalMs: 5 }),
    ).rejects.toThrow("AD_MANAGER_REPORT_CREATE_FAILED");
  });

  it("an empty result (fetchRows omits rows) returns zero rows, not an error", async () => {
    fetchStub(({ url }) => {
      if (url.endsWith("/networks/123/reports")) return { name: REPORT_NAME, reportId: "455" };
      if (url.endsWith(`/${REPORT_NAME}:run`)) return { name: OP_NAME, done: false };
      if (url.endsWith(`/${OP_NAME}`)) return { name: OP_NAME, done: true, response: { reportResult: RESULT_NAME } };
      if (url.includes(`${RESULT_NAME}:fetchRows`)) return { totalRowCount: 0 };
      throw new Error(`unexpected fetch: ${url}`);
    });
    const out = await runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", {
      pollTimeoutMs: 1000,
      pollIntervalMs: 5,
    });
    expect(out.parsed).toBe(true);
    expect(out.rows).toEqual([]);
    expect(out.totalRowCount).toBe(0);
    expect(out.truncated).toBe(false);
  });
});

describe("parseAdManagerReport — real fetchRows shapes", () => {
  it("parses metricValueGroups with int/double/micros values", () => {
    const out = parseAdManagerReport({ rows: PAGE_1_ROWS, totalRowCount: 1 });
    expect(out.parsed).toBe(true);
    expect(out.rows).toEqual([{ dimensions: ["2026-11-01", "Homepage"], metrics: [1000, 25, 0.025, 12.5] }]);
    expect(out.totals.TOTAL_REVENUE).toBe(12.5);
  });

  it("parses a DATE dimensionValue object to an ISO date", () => {
    const out = parseAdManagerReport({
      rows: [
        {
          dimensionValues: [{ dateValue: { year: 2026, month: 11, day: 3 } }, { intValue: "6378470710" }],
          metricValueGroups: [{ primaryValues: [{ intValue: "7" }] }],
        },
      ],
    });
    expect(out.rows).toEqual([{ dimensions: ["2026-11-03", "6378470710"], metrics: [7] }]);
  });
});
