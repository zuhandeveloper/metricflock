import { describe, it, expect, beforeEach, vi } from "vitest";

// packages/google/src/search-console.ts — querySearchAnalytics (totals
// query, detail pagination, truncation flag, totals fallback),
// listSitemaps and inspectUrl. The parse helpers are covered by
// search-console-parse.test.ts. googleapis is mocked; no network.
const mocks = vi.hoisted(() => ({
  scQuery: vi.fn(),
  sitemapsList: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    searchconsole: () => ({
      searchanalytics: { query: mocks.scQuery },
      sitemaps: { list: mocks.sitemapsList },
      urlInspection: { index: { inspect: mocks.inspect } },
    }),
  },
}));

import {
  querySearchAnalytics,
  listSitemaps,
  inspectUrl,
  parseGscRows,
  GSC_DATA_DELAY_NOTE,
} from "@metricflock/google/search-console";

const auth = {} as never;
const SITE = "https://example.com/";

function gscRow(keys: string[], clicks: number, impressions: number, ctr: number, position: number) {
  return { keys, clicks, impressions, ctr, position };
}

describe("querySearchAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the totals query for totals and the detail query for rows", async () => {
    mocks.scQuery.mockResolvedValueOnce({ data: { rows: [gscRow([], 10, 100, 0.1, 2)] } }).mockResolvedValueOnce({
      data: {
        rows: [
          gscRow(["2026-11-01", "q1", "/p1"], 6, 60, 0.1, 1.5),
          gscRow(["2026-11-01", "q2", "/p2"], 4, 40, 0.1, 3),
        ],
      },
    });
    const out = await querySearchAnalytics(auth, SITE, "2026-11-01", "2026-11-02");
    expect(out.totals).toEqual({ clicks: 10, impressions: 100, avgCtr: 0.1, avgPosition: 2 });
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(false);
    expect(out.siteUrl).toBe(SITE);
    expect(out.dataDelayNote).toBe(GSC_DATA_DELAY_NOTE);
    // Totals query: dimension-less, one row.
    expect(mocks.scQuery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        siteUrl: SITE,
        requestBody: { startDate: "2026-11-01", endDate: "2026-11-02", dimensions: [], rowLimit: 1 },
      }),
      expect.anything(),
    );
    // Detail query: the default dimension (["date"]), first page.
    expect(mocks.scQuery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestBody: expect.objectContaining({ dimensions: ["date"], rowLimit: 1000, startRow: 0 }),
      }),
      expect.anything(),
    );
  });

  it("computes totals from detail rows when the totals query returns nothing", async () => {
    mocks.scQuery.mockResolvedValueOnce({ data: { rows: undefined } }).mockResolvedValueOnce({
      data: { rows: [gscRow(["2026-11-01"], 90, 900, 0.1, 1), gscRow(["2026-11-02"], 10, 100, 0.1, 10)] },
    });
    const out = await querySearchAnalytics(auth, SITE, "2026-11-01", "2026-11-02");
    // DATA-2: impression-weighted position (1*900 + 10*100) / 1000 = 1.9.
    expect(out.totals).toEqual({ clicks: 100, impressions: 1000, avgCtr: 0.1, avgPosition: 1.9 });
  });

  it("reports avgPosition null when the totals row has no impressions", async () => {
    mocks.scQuery
      .mockResolvedValueOnce({ data: { rows: [gscRow([], 0, 0, 0, 0)] } })
      .mockResolvedValueOnce({ data: { rows: [] } });
    const out = await querySearchAnalytics(auth, SITE, "2026-11-01", "2026-11-02");
    expect(out.totals.avgPosition).toBeNull();
  });

  it("paginates detail rows with startRow until a short page", async () => {
    mocks.scQuery.mockResolvedValueOnce({ data: { rows: [gscRow([], 5, 50, 0.1, 2)] } });
    const pages = [
      [gscRow(["a"], 3, 30, 0.1, 1), gscRow(["b"], 2, 20, 0.1, 3)],
      [gscRow(["c"], 1, 10, 0.1, 2), gscRow(["d"], 1, 10, 0.1, 2)],
      [gscRow(["e"], 1, 10, 0.1, 2)],
    ];
    for (const rows of pages) mocks.scQuery.mockResolvedValueOnce({ data: { rows } });
    const out = await querySearchAnalytics(auth, SITE, "2026-11-01", "2026-11-02", ["query"], 2);
    expect(out.rows).toHaveLength(5);
    expect(out.truncated).toBe(false);
    expect(mocks.scQuery).toHaveBeenCalledTimes(4); // totals + 3 detail pages
    expect(mocks.scQuery).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ requestBody: expect.objectContaining({ startRow: 4 }) }),
      expect.anything(),
    );
  });

  it("flags truncated when every page is full through the page cap", async () => {
    mocks.scQuery.mockResolvedValueOnce({ data: { rows: [gscRow([], 5, 50, 0.1, 2)] } });
    mocks.scQuery.mockImplementation(async () => ({ data: { rows: [gscRow(["x"], 1, 10, 0.1, 2)] } }));
    const out = await querySearchAnalytics(auth, SITE, "2026-11-01", "2026-11-02", ["query"], 1);
    expect(out.rows).toHaveLength(5);
    expect(out.truncated).toBe(true);
    expect(mocks.scQuery).toHaveBeenCalledTimes(6); // totals + 5 detail pages
  });
});

describe("listSitemaps", () => {
  it("maps sitemap entries", async () => {
    mocks.sitemapsList.mockResolvedValue({
      data: {
        sitemap: [{ path: "https://example.com/sitemap.xml", lastSubmitted: "2026-11-01", errors: "0", contents: [] }],
      },
    });
    await expect(listSitemaps(auth, SITE)).resolves.toEqual([
      expect.objectContaining({ path: "https://example.com/sitemap.xml", lastSubmitted: "2026-11-01" }),
    ]);
    expect(mocks.sitemapsList).toHaveBeenCalledWith({ siteUrl: SITE }, expect.objectContaining({ timeout: 15000 }));
  });

  it("returns an empty list when the site has no sitemaps", async () => {
    mocks.sitemapsList.mockResolvedValue({ data: {} });
    await expect(listSitemaps(auth, SITE)).resolves.toEqual([]);
  });
});

describe("inspectUrl", () => {
  it("returns the inspection result", async () => {
    const result = { indexStatusResult: { verdict: "PASS" } };
    mocks.inspect.mockResolvedValue({ data: { inspectionResult: result } });
    await expect(inspectUrl(auth, SITE, "https://example.com/page")).resolves.toBe(result);
    expect(mocks.inspect).toHaveBeenCalledWith(
      { requestBody: { siteUrl: SITE, inspectionUrl: "https://example.com/page" } },
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  it("returns null when there is no inspection result", async () => {
    mocks.inspect.mockResolvedValue({ data: {} });
    await expect(inspectUrl(auth, SITE, "https://example.com/page")).resolves.toBeNull();
  });
});

describe("parseGscRows defaults", () => {
  it("fills every missing field from a sparse row", () => {
    expect(parseGscRows([{} as never, { keys: ["q"] } as never])).toEqual([
      { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 },
      { keys: ["q"], clicks: 0, impressions: 0, ctr: 0, position: 0 },
    ]);
  });
});
