import { describe, it, expect } from "vitest";
import { parseGscRows, computeGscTotals, GSC_DATA_DELAY_NOTE } from "@metricflock/google/search-console";
describe("Search Console parser", () => {
  it("parses rows with defaults", () => {
    expect(parseGscRows([{ keys: ["q"], clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 }])).toEqual([
      { keys: ["q"], clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 },
    ]);
    expect(parseGscRows(undefined)).toEqual([]);
  });
  it("documents the 2-3 day data delay", () => {
    expect(GSC_DATA_DELAY_NOTE).toMatch(/delayed/);
  });
  it("DATA-2: average position is impression-weighted, not a simple mean", () => {
    // Simple mean would be (1 + 10) / 2 = 5.5. Weighted by impressions:
    // (1*900 + 10*100) / 1000 = 1.9.
    const totals = computeGscTotals([
      { keys: ["a"], clicks: 90, impressions: 900, ctr: 0.1, position: 1 },
      { keys: ["b"], clicks: 2, impressions: 100, ctr: 0.02, position: 10 },
    ]);
    expect(totals).toEqual({ clicks: 92, impressions: 1000, avgCtr: 0.092, avgPosition: 1.9 });
  });
  it("DATA-2: avgPosition is null when there are no impressions", () => {
    expect(computeGscTotals([])).toEqual({ clicks: 0, impressions: 0, avgCtr: 0, avgPosition: null });
    expect(computeGscTotals([{ keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 }]).avgPosition).toBeNull();
  });
});
