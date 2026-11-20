import { describe, it, expect } from "vitest";
import { parseRealtimeRows, parseReportRows } from "@metricflock/google/ga4";
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
});
