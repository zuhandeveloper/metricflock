import { describe, it, expect } from "vitest";
import { parseAdSenseRows, ADSENSE_ESTIMATED_NOTE } from "@/lib/google/adsense";
describe("AdSense parser", () => {
  it("parses rows against headers, coercing numbers", () => {
    const rows = parseAdSenseRows([{ cells: [{ value: "2026-11-01" }, { value: "12.34" }] }], ["DATE", "ESTIMATED_EARNINGS"]);
    expect(rows).toEqual([{ DATE: "2026-11-01", ESTIMATED_EARNINGS: 12.34 }]);
  });
  it("labels earnings as estimated, not finalized", () => { expect(ADSENSE_ESTIMATED_NOTE).toMatch(/estimated/i); });
});
