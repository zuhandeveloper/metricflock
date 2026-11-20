import { describe, it, expect } from "vitest";
import { parseGscRows, GSC_DATA_DELAY_NOTE } from "@metricflock/google/search-console";
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
});
