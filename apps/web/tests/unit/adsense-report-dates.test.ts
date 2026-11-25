import { describe, it, expect, beforeEach, vi } from "vitest";

// packages/google/src/adsense.ts — runAdSenseReport date validation
// (A-GGL-08). The old slice-based dateParts admitted "2026-1-5" (month
// NaN), "2026-02-30" and "not-a-date", which Google then rejected with a
// generic provider 502. Now both dates are strictly validated — and
// startDate <= endDate enforced — before any provider call is made.
// googleapis is mocked; no network.
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    adsense: () => ({
      accounts: { reports: { generate: mocks.generate } },
    }),
  },
}));

import { runAdSenseReport } from "@metricflock/google/adsense";

const auth = {} as never;

function okResponse() {
  return {
    data: {
      headers: [{ name: "DATE" }, { name: "ESTIMATED_EARNINGS" }],
      rows: [{ cells: [{ value: "2026-02-01" }, { value: "1.23" }] }],
      totals: { cells: [{ value: "" }, { value: "1.23" }] },
    },
  };
}

describe("runAdSenseReport date validation (A-GGL-08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generate.mockResolvedValue(okResponse());
  });

  it.each(["2026-02-30", "2026-1-5", "2026-13-01", "not-a-date"])(
    "throws ADSENSE_INVALID_DATE for %s and makes no provider call",
    async (badDate) => {
      await expect(runAdSenseReport(auth, "pub-1", badDate, "2026-02-28")).rejects.toThrow("ADSENSE_INVALID_DATE");
      await expect(runAdSenseReport(auth, "pub-1", "2026-02-01", badDate)).rejects.toThrow("ADSENSE_INVALID_DATE");
      expect(mocks.generate).not.toHaveBeenCalled();
    },
  );

  it("throws ADSENSE_INVALID_DATE when startDate is after endDate, with no provider call", async () => {
    await expect(runAdSenseReport(auth, "pub-1", "2026-02-10", "2026-02-01")).rejects.toThrow("ADSENSE_INVALID_DATE");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("accepts a real leap day and passes strict year/month/day parts to Google", async () => {
    const out = await runAdSenseReport(auth, "pub-1", "2024-02-29", "2024-03-01");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const args = mocks.generate.mock.calls[0]![0] as Record<string, unknown>;
    expect(args["startDate.year"]).toBe(2024);
    expect(args["startDate.month"]).toBe(2);
    expect(args["startDate.day"]).toBe(29);
    expect(args["endDate.year"]).toBe(2024);
    expect(args["endDate.month"]).toBe(3);
    expect(args["endDate.day"]).toBe(1);
    expect(out.startDate).toBe("2024-02-29");
    expect(out.endDate).toBe("2024-03-01");
  });

  it("rejects the non-leap-year 2025-02-29", async () => {
    await expect(runAdSenseReport(auth, "pub-1", "2025-02-29", "2025-03-01")).rejects.toThrow("ADSENSE_INVALID_DATE");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
