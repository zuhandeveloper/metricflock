import { describe, it, expect } from "vitest";
import { parseAdManagerReport } from "@metricflock/google/ad-manager";
describe("Ad Manager parser (DATA-9)", () => {
  it("parses dimensionValues/metricValues rows and totals them per metric", () => {
    const out = parseAdManagerReport({
      rows: [
        {
          dimensionValues: [{ value: "2026-11-01" }, { value: "Homepage" }],
          metricValues: [{ value: "1000" }, { value: "25" }, { value: "0.025" }, { value: "12.5" }],
        },
        {
          dimensionValues: [{ value: "2026-11-02" }, { value: "Homepage" }],
          metricValues: [{ value: "500" }, { value: "10" }, { value: "0.02" }, { value: "6.25" }],
        },
      ],
    });
    expect(out.parsed).toBe(true);
    expect(out.rows[0]).toEqual({ dimensions: ["2026-11-01", "Homepage"], metrics: [1000, 25, 0.025, 12.5] });
    expect(out.totals).toEqual({
      AD_SERVER_IMPRESSIONS: 1500,
      AD_SERVER_CLICKS: 35,
      AD_SERVER_CTR: 0.045,
      TOTAL_REVENUE: 18.75,
    });
  });
  it("finds rows under result.rows / report.rows wrappers", () => {
    const row = { dimensionValues: [{ value: "2026-11-01" }], metricValues: [{ value: "3" }] };
    expect(parseAdManagerReport({ result: { rows: [row] } }).parsed).toBe(true);
    expect(parseAdManagerReport({ report: { rows: [row] } }).parsed).toBe(true);
  });
  it("unrecognized shapes yield parsed:false and no invented numbers", () => {
    expect(parseAdManagerReport({ something: "else" })).toEqual({ parsed: false, rows: [], totals: {} });
    expect(parseAdManagerReport(null)).toEqual({ parsed: false, rows: [], totals: {} });
    expect(parseAdManagerReport(undefined)).toEqual({ parsed: false, rows: [], totals: {} });
  });
});
