import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseAdManagerReport,
  parseAdManagerDate,
  runAdManagerReport,
  listAdManagerNetworks,
} from "@metricflock/google/ad-manager";
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
    // F-3.4: total CTR is recomputed from totals (35/1500), never the
    // sum of per-row CTRs (0.025 + 0.02 = 0.045 would be meaningless).
    expect(out.totals).toEqual({
      AD_SERVER_IMPRESSIONS: 1500,
      AD_SERVER_CLICKS: 35,
      AD_SERVER_CTR: 35 / 1500,
      TOTAL_REVENUE: 18.75,
    });
  });
  it("total CTR is 0 when there are no impressions", () => {
    const out = parseAdManagerReport({
      rows: [
        {
          dimensionValues: [{ value: "2026-11-01" }],
          metricValues: [{ value: "0" }, { value: "0" }, { value: "0" }, { value: "0" }],
        },
      ],
    });
    expect(out.totals.AD_SERVER_CTR).toBe(0);
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

describe("Ad Manager dates (F-3.4)", () => {
  it("parses a valid date", () => {
    expect(parseAdManagerDate("2026-11-21")).toEqual({ year: 2026, month: 11, day: 21 });
  });
  it("rejects malformed and impossible dates", () => {
    for (const bad of ["2026/11/21", "21-11-2026", "2026-13-01", "2026-02-30", "not-a-date", ""]) {
      expect(() => parseAdManagerDate(bad)).toThrow("AD_MANAGER_INVALID_DATE");
    }
  });
  it("runAdManagerReport rejects invalid dates before any fetch", async () => {
    process.env.GOOGLE_AD_MANAGER_ENABLED = "true";
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchSpy);
    const auth = { getAccessToken: async () => ({ token: "tok" }) } as never;
    await expect(runAdManagerReport(auth, "123", "2026-13-40", "2026-11-01")).rejects.toThrow(
      "AD_MANAGER_INVALID_DATE",
    );
    await expect(runAdManagerReport(auth, "123", "2026-11-10", "2026-11-01")).rejects.toThrow(
      "AD_MANAGER_INVALID_DATE",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
  });
});

describe("Ad Manager networks pagination + retry (F-3.3/F-3.4)", () => {
  const auth = { getAccessToken: async () => ({ token: "tok" }) } as never;
  beforeEach(() => {
    process.env.GOOGLE_AD_MANAGER_ENABLED = "true";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
  });

  it("follows nextPageToken across pages", async () => {
    const pages = [
      { networks: [{ networkCode: "1", displayName: "A" }], nextPageToken: "p2" },
      { networks: [{ networkCode: "2", displayName: "B" }] },
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => pages[call++] })),
    );
    const out = await listAdManagerNetworks(auth);
    expect(out.map((n) => n.networkCode)).toEqual(["1", "2"]);
    expect(call).toBe(2);
  });

  it("retries transient 500s and succeeds", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call < 3) return { ok: false, status: 500, text: async () => "boom" };
        return { ok: true, status: 200, json: async () => ({ networks: [{ networkCode: "9" }] }) };
      }),
    );
    // A-COV-12: admFetch's backoff (500·2^n ms + jitter, ~1.7 s real time)
    // is module-private with no injection point, so fake timers drive it —
    // the retry semantics under test are unchanged, no real waiting occurs.
    vi.useFakeTimers();
    try {
      const promise = listAdManagerNetworks(auth);
      await vi.advanceTimersByTimeAsync(5_000);
      const out = await promise;
      expect(out).toEqual([{ networkCode: "9", displayName: undefined }]);
      expect(call).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-transient 403s", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        return { ok: false, status: 403, text: async () => "denied" };
      }),
    );
    await expect(listAdManagerNetworks(auth)).rejects.toThrow("AD_MANAGER_API_ERROR_403");
    expect(call).toBe(1);
  });
});
