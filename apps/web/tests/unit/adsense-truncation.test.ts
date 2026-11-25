import { describe, it, expect, beforeEach, vi } from "vitest";

// packages/google/src/adsense.ts — runAdSenseReport truncation detection
// (A-GGL-09). The AdSense v2 API caps GenerateReport rows (default
// 100,000, also the max `limit`) and reports the full match count in
// `total_matched_rows`; there is no pageToken to page with. The report
// now mirrors GA4 (`rowCount`, `truncated: rowCount > rows.length`) so
// callers never treat a truncated detail set as complete. The flag
// flows through the analytics handler (envelope `data`) and the worker
// sync (snapshot payload) unchanged — both pass the report object
// through wholesale. googleapis is mocked; no network.
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

function response(opts: { rows: number; totalMatchedRows?: string | number | null }) {
  const rows = Array.from({ length: opts.rows }, (_, i) => ({
    cells: [{ value: `2026-11-0${i + 1}` }, { value: "1.23" }],
  }));
  return {
    data: {
      headers: [{ name: "DATE" }, { name: "ESTIMATED_EARNINGS" }],
      rows,
      totals: { cells: [{ value: "" }, { value: "1.23" }] },
      ...(opts.totalMatchedRows === undefined ? {} : { totalMatchedRows: String(opts.totalMatchedRows) }),
    },
  };
}

describe("runAdSenseReport truncation detection (A-GGL-09)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flags truncated: true when totalMatchedRows exceeds the returned rows", async () => {
    mocks.generate.mockResolvedValue(response({ rows: 2, totalMatchedRows: 5 }));
    const out = await runAdSenseReport(auth, "pub-1", "2026-11-01", "2026-11-02");
    expect(out.rowCount).toBe(5);
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(2);
  });

  it("flags truncated: false when totalMatchedRows equals the returned rows", async () => {
    mocks.generate.mockResolvedValue(response({ rows: 2, totalMatchedRows: 2 }));
    const out = await runAdSenseReport(auth, "pub-1", "2026-11-01", "2026-11-02");
    expect(out.rowCount).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it("falls back to the returned row count when the API omits totalMatchedRows", async () => {
    mocks.generate.mockResolvedValue(response({ rows: 2 }));
    const out = await runAdSenseReport(auth, "pub-1", "2026-11-01", "2026-11-02");
    expect(out.rowCount).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it("falls back to the returned row count for a non-numeric totalMatchedRows", async () => {
    mocks.generate.mockResolvedValue(response({ rows: 2, totalMatchedRows: "not-a-number" }));
    const out = await runAdSenseReport(auth, "pub-1", "2026-11-01", "2026-11-02");
    expect(out.rowCount).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it("flags truncated: false when totalMatchedRows is smaller than the returned rows", async () => {
    mocks.generate.mockResolvedValue(response({ rows: 2, totalMatchedRows: 1 }));
    const out = await runAdSenseReport(auth, "pub-1", "2026-11-01", "2026-11-02");
    expect(out.rowCount).toBe(1);
    expect(out.truncated).toBe(false);
  });
});
