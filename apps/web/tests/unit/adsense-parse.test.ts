import { describe, it, expect } from "vitest";
import { parseAdSenseRows, parseAdSenseTotals, ADSENSE_ESTIMATED_NOTE } from "@metricflock/google/adsense";
describe("AdSense parser", () => {
  it("parses rows against headers, coercing numbers", () => {
    const rows = parseAdSenseRows(
      [{ cells: [{ value: "2026-11-01" }, { value: "12.34" }] }],
      ["DATE", "ESTIMATED_EARNINGS"],
    );
    expect(rows).toEqual([{ DATE: "2026-11-01", ESTIMATED_EARNINGS: 12.34 }]);
  });
  it("labels earnings as estimated, not finalized", () => {
    expect(ADSENSE_ESTIMATED_NOTE).toMatch(/estimated/i);
  });
  it("DATA-9: provider totals are keyed by header with numeric coercion", () => {
    const totals = parseAdSenseTotals({ cells: [{ value: "123.45" }, { value: "6789" }, { value: "" }] }, [
      "ESTIMATED_EARNINGS",
      "PAGE_VIEWS",
      "IMPRESSIONS_CTR",
    ]);
    expect(totals).toEqual({ ESTIMATED_EARNINGS: 123.45, PAGE_VIEWS: 6789, IMPRESSIONS_CTR: "" });
    expect(parseAdSenseTotals(undefined, ["ESTIMATED_EARNINGS"])).toEqual({ ESTIMATED_EARNINGS: "" });
  });
});
