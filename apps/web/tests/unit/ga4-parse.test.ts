import { describe, it, expect } from "vitest";
import {
  parseRealtimeRows,
  parseRealtimeTotals,
  parseRealtimeBreakdown,
  parseReportRows,
  parseHistoricalSummary,
  parseSamplingMetadata,
} from "@metricflock/google/ga4";
describe("GA4 parsers", () => {
  it("parses realtime rows", () => {
    const rows = parseRealtimeRows([{ dimensionValues: [{ value: "US" }], metricValues: [{ value: "12" }] }], 1);
    expect(rows).toEqual([{ dimensions: ["US"], activeUsers: 12 }]);
  });
  it("parses historical rows into typed metrics", () => {
    const rows = parseReportRows(
      [{ dimensionValues: [{ value: "2026-11-01" }], metricValues: [{ value: "100" }, { value: "80" }] }],
      ["totalUsers", "sessions"],
    );
    expect(rows[0]).toEqual({ dimension0: "2026-11-01", totalUsers: 100, sessions: 80 });
  });
  it("handles missing rows as empty, not zero-invented data", () => {
    expect(parseRealtimeRows(undefined, 1)).toEqual([]);
    expect(parseReportRows(undefined, ["sessions"])).toEqual([]);
  });
  it("DATA-1: dimension-less realtime total is the provider total, not a row sum", () => {
    // One user viewing 3 pages: a multi-dimension report would have 3 rows
    // of activeUsers=1 (sum=3). The dimension-less query returns ONE row
    // with the true total — parseRealtimeTotals must read it verbatim.
    const totals = parseRealtimeTotals([{ metricValues: [{ value: "1" }, { value: "7" }] }]);
    expect(totals).toEqual({ activeUsers: 1, eventCount: 7 });
    expect(parseRealtimeTotals(undefined)).toEqual({ activeUsers: 0, eventCount: 0 });
  });
  it("DATA-1: single-dimension breakdown is sorted, capped at 10, exact per value", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      dimensionValues: [{ value: `C${i}` }],
      metricValues: [{ value: String(i + 1) }],
    }));
    const out = parseRealtimeBreakdown(rows);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ name: "C11", activeUsers: 12 });
    expect(out[9]).toEqual({ name: "C2", activeUsers: 3 });
    expect(parseRealtimeBreakdown([{ metricValues: [{ value: "4" }] }])).toEqual([
      { name: "(not set)", activeUsers: 4 },
    ]);
  });
  it("DATA-8: missing totals row yields null per metric, never 0", () => {
    expect(parseHistoricalSummary(undefined, ["totalUsers", "sessions"])).toEqual({
      totalUsers: null,
      sessions: null,
    });
    expect(
      parseHistoricalSummary({ metricValues: [{ value: "42" }, { value: "0" }] }, ["totalUsers", "sessions"]),
    ).toEqual({ totalUsers: 42, sessions: 0 });
    // A real zero from the provider stays 0 — only ABSENT values are null.
    expect(parseHistoricalSummary({ metricValues: [{ value: "5" }] }, ["totalUsers", "sessions"])).toEqual({
      totalUsers: 5,
      sessions: null,
    });
  });
  it("DATA-7: sampling metadata flags sampled/thresholded data", () => {
    expect(parseSamplingMetadata(undefined)).toEqual({
      sampled: false,
      samplesReadCount: null,
      samplingSpaceSize: null,
      subjectToThresholding: false,
      dataLossFromOtherRow: false,
    });
    expect(
      parseSamplingMetadata({
        samplingMetadatas: [{ samplesReadCount: "1000", samplingSpaceSize: "5000" }],
        subjectToThresholding: true,
      }),
    ).toEqual({
      sampled: true,
      samplesReadCount: 1000,
      samplingSpaceSize: 5000,
      subjectToThresholding: true,
      dataLossFromOtherRow: false,
    });
    // Full read (samples == space) is not sampled.
    expect(
      parseSamplingMetadata({ samplingMetadatas: [{ samplesReadCount: 5000, samplingSpaceSize: 5000 }] }).sampled,
    ).toBe(false);
  });
});
