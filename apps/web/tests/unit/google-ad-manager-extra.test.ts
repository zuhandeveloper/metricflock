import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  adManagerEnabled,
  parseAdManagerReport,
  runAdManagerReport,
  listAdManagerNetworks,
} from "@metricflock/google/ad-manager";

// Ad Manager REST paths not covered by ad-manager-flow.test.ts /
// ad-manager-parse.test.ts: disabled feature, missing access token,
// retryable network failures, run/report-result failures,
// unrecognized fetchRows shapes, truncation, the dimension-value
// fallbacks, the networks loop guard, and the abort-timer callback.
const auth = { getAccessToken: async () => ({ token: "tok" }) } as never;
const REPORT_NAME = "networks/123/reports/455";
const OP_NAME = "networks/123/operations/reports/runs/648";
const RESULT_NAME = "networks/123/reports/455/results/703";

type FetchImpl = (url: string, init?: RequestInit) => Promise<unknown>;
function stubFetch(impl: FetchImpl) {
  vi.stubGlobal("fetch", vi.fn(impl));
}
function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => "" };
}
function errRes(status: number, text = "boom") {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

/** Minimal happy-path stub: create → run (done) → fetchRows. */
function happyStub(rows: unknown[] = [], totalRowCount: number | null = null) {
  return stubFetch(async (url: string) => {
    if (url.endsWith("/networks/123/reports")) return okJson({ name: REPORT_NAME });
    if (url.endsWith(`/${REPORT_NAME}:run`))
      return okJson({ name: OP_NAME, done: true, response: { reportResult: RESULT_NAME } });
    if (url.includes(`${RESULT_NAME}:fetchRows`)) return okJson({ rows, totalRowCount });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("adManagerEnabled / disabled feature", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
  });

  it('is false unless GOOGLE_AD_MANAGER_ENABLED is exactly "true"', () => {
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
    expect(adManagerEnabled()).toBe(false);
    process.env.GOOGLE_AD_MANAGER_ENABLED = "1";
    expect(adManagerEnabled()).toBe(false);
    process.env.GOOGLE_AD_MANAGER_ENABLED = "true";
    expect(adManagerEnabled()).toBe(true);
  });

  it("runAdManagerReport throws AD_MANAGER_DISABLED without fetching", async () => {
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
    const fetchSpy = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02")).rejects.toThrow("AD_MANAGER_DISABLED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("listAdManagerNetworks throws AD_MANAGER_DISABLED without fetching", async () => {
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
    const fetchSpy = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(listAdManagerNetworks(auth)).rejects.toThrow("AD_MANAGER_DISABLED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runAdManagerReport failure paths", () => {
  beforeEach(() => {
    process.env.GOOGLE_AD_MANAGER_ENABLED = "true";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
  });

  it("throws AD_MANAGER_NO_ACCESS_TOKEN when the OAuth client has no token", async () => {
    const noToken = { getAccessToken: async () => ({ token: null }) } as never;
    const fetchSpy = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(runAdManagerReport(noToken, "123", "2026-11-01", "2026-11-02")).rejects.toThrow(
      "AD_MANAGER_NO_ACCESS_TOKEN",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retries a transient 429 and then succeeds", async () => {
    let calls = 0;
    stubFetch(async (url: string) => {
      calls++;
      if (calls === 1) return errRes(429, "rate limited");
      if (url.endsWith("/networks/123/reports")) return okJson({ name: REPORT_NAME });
      if (url.endsWith(`/${REPORT_NAME}:run`))
        return okJson({ name: OP_NAME, done: true, response: { reportResult: RESULT_NAME } });
      if (url.includes(`${RESULT_NAME}:fetchRows`)) return okJson({ rows: [], totalRowCount: 0 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const out = await runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", {
      pollTimeoutMs: 1000,
      pollIntervalMs: 5,
    });
    expect(out.parsed).toBe(true);
    expect(out.rows).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(4); // 429 + create + run + fetchRows
  });

  it("retries network failures three times and then throws the last error", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", { pollTimeoutMs: 1000, pollIntervalMs: 5 }),
    ).rejects.toThrow("socket hang up");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("throws AD_MANAGER_REPORT_RUN_FAILED when run returns no operation name", async () => {
    stubFetch(async (url: string) => {
      if (url.endsWith("/networks/123/reports")) return okJson({ name: REPORT_NAME });
      if (url.endsWith(`/${REPORT_NAME}:run`)) return okJson({ done: true });
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(
      runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", { pollTimeoutMs: 1000, pollIntervalMs: 5 }),
    ).rejects.toThrow("AD_MANAGER_REPORT_RUN_FAILED");
  });

  it("throws AD_MANAGER_REPORT_FAILED when the completed operation has no report result", async () => {
    stubFetch(async (url: string) => {
      if (url.endsWith("/networks/123/reports")) return okJson({ name: REPORT_NAME });
      if (url.endsWith(`/${REPORT_NAME}:run`)) return okJson({ name: OP_NAME, done: true, response: {} });
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(
      runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", { pollTimeoutMs: 1000, pollIntervalMs: 5 }),
    ).rejects.toThrow("AD_MANAGER_REPORT_FAILED: completed operation returned no report result");
  });

  it("throws AD_MANAGER_REPORT_UNRECOGNIZED_SHAPE for unparseable fetchRows", async () => {
    stubFetch(async (url: string) => {
      if (url.endsWith("/networks/123/reports")) return okJson({ name: REPORT_NAME });
      if (url.endsWith(`/${REPORT_NAME}:run`))
        return okJson({ name: OP_NAME, done: true, response: { reportResult: RESULT_NAME } });
      if (url.includes(`${RESULT_NAME}:fetchRows`)) return okJson({ rows: "not-an-array" });
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(
      runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", { pollTimeoutMs: 1000, pollIntervalMs: 5 }),
    ).rejects.toThrow("AD_MANAGER_REPORT_UNRECOGNIZED_SHAPE");
  });

  it("flags truncated when totalRowCount exceeds the rows returned", async () => {
    happyStub(
      [
        {
          dimensionValues: [{ stringValue: "2026-11-01" }],
          metricValueGroups: [{ primaryValues: [{ intValue: "10" }] }],
        },
      ],
      5,
    );
    const out = await runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", {
      pollTimeoutMs: 1000,
      pollIntervalMs: 5,
    });
    expect(out.rows).toHaveLength(1);
    expect(out.totalRowCount).toBe(5);
    expect(out.truncated).toBe(true);
  });

  it("reports totalRowCount null when the response omits it", async () => {
    happyStub([
      {
        dimensionValues: [{ stringValue: "2026-11-01" }],
        metricValueGroups: [{ primaryValues: [{ intValue: "10" }] }],
      },
    ]);
    const out = await runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", {
      pollTimeoutMs: 1000,
      pollIntervalMs: 5,
    });
    expect(out.rows).toHaveLength(1);
    expect(out.totalRowCount).toBeNull();
    expect(out.truncated).toBe(false);
  });

  it("aborts a hung request after the 15s timeout and retries (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("The operation was aborted.", "AbortError")),
              );
            }),
        ),
      );
      const promise = runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", {
        pollTimeoutMs: 1000,
        pollIntervalMs: 5,
      });
      const assertion = expect(promise).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseAdManagerReport dimension fallbacks", () => {
  it("stringifies doubleValue dimensions", () => {
    const out = parseAdManagerReport({
      rows: [
        {
          dimensionValues: [{ doubleValue: 1.5 }],
          metricValueGroups: [{ primaryValues: [{ intValue: "3" }] }],
        },
      ],
    });
    expect(out.rows).toEqual([{ dimensions: ["1.5"], metrics: [3] }]);
  });

  it("returns an empty string for unrecognized or partial dimension values", () => {
    const out = parseAdManagerReport({
      rows: [
        {
          dimensionValues: [{}, { dateValue: { year: 2026 } }],
          metricValueGroups: [{ primaryValues: [{ intValue: "3" }] }],
        },
      ],
    });
    expect(out.rows).toEqual([{ dimensions: ["", ""], metrics: [3] }]);
  });
});

describe("listAdManagerNetworks loop guard", () => {
  beforeEach(() => {
    process.env.GOOGLE_AD_MANAGER_ENABLED = "true";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
  });

  it("stops when nextPageToken repeats instead of looping forever", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return okJson({ networks: [{ networkCode: `${calls}` }], nextPageToken: "same-token" });
      }),
    );
    const out = await listAdManagerNetworks(auth);
    expect(out.map((n) => n.networkCode)).toEqual(["1", "2"]);
    expect(calls).toBe(2);
  });

  it("flags truncated when the page token loops (A-GGL-20)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ networks: [{ networkCode: "1" }], nextPageToken: "same-token" })),
    );
    const out = await listAdManagerNetworks(auth);
    expect(out.truncated).toBe(true);
  });

  it("flags truncated when the page cap cuts the listing short (A-GGL-20)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return okJson({ networks: [{ networkCode: `${calls}` }], nextPageToken: `tok-${calls}` });
      }),
    );
    const out = await listAdManagerNetworks(auth);
    expect(out).toHaveLength(10);
    expect(out.truncated).toBe(true);
  });

  it("leaves truncated unset on a complete listing (A-GGL-20)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ networks: [{ networkCode: "1" }] })),
    );
    const out = await listAdManagerNetworks(auth);
    expect(out.truncated).toBeUndefined();
  });

  it("returns an empty list when there are no networks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ networks: [] })),
    );
    await expect(listAdManagerNetworks(auth)).resolves.toEqual([]);
  });

  it("returns an empty list when the response has no networks key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({})),
    );
    await expect(listAdManagerNetworks(auth)).resolves.toEqual([]);
  });

  it("defaults a network without a code or displayName", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ networks: [{ displayName: "No code" }, {}] })),
    );
    await expect(listAdManagerNetworks(auth)).resolves.toEqual([
      { networkCode: "", displayName: "No code" },
      { networkCode: "", displayName: undefined },
    ]);
  });
});

describe("admFetch error-body and non-Error failures", () => {
  beforeEach(() => {
    process.env.GOOGLE_AD_MANAGER_ENABLED = "true";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_AD_MANAGER_ENABLED;
  });

  it("tolerates an unreadable error body (empty message suffix)", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => {
        throw new Error("body gone");
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", { pollTimeoutMs: 1000, pollIntervalMs: 5 }),
    ).rejects.toThrow("AD_MANAGER_API_ERROR_500: ");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("wraps a non-Error fetch rejection and retries it", async () => {
    const fetchSpy = vi.fn(async () => {
      throw "network string failure";
    });
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", { pollTimeoutMs: 1000, pollIntervalMs: 5 }),
    ).rejects.toThrow("network string failure");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("formats a bare-code operation error and a response-less operation", async () => {
    const runWithOp = async (op: unknown) => {
      stubFetch(async (url: string) => {
        if (url.endsWith("/networks/123/reports")) return okJson({ name: REPORT_NAME });
        if (url.endsWith(`/${REPORT_NAME}:run`)) return okJson(op);
        throw new Error(`unexpected fetch: ${url}`);
      });
      return runAdManagerReport(auth, "123", "2026-11-01", "2026-11-02", {
        pollTimeoutMs: 1000,
        pollIntervalMs: 5,
      });
    };
    await expect(runWithOp({ name: OP_NAME, done: true, error: { code: 500 } })).rejects.toThrow(
      "AD_MANAGER_REPORT_FAILED: 500 report run failed",
    );
    await expect(runWithOp({ name: OP_NAME, done: true, error: {} })).rejects.toThrow(
      "AD_MANAGER_REPORT_FAILED: report run failed",
    );
    await expect(runWithOp({ name: OP_NAME, done: true })).rejects.toThrow(
      "AD_MANAGER_REPORT_FAILED: completed operation returned no report result",
    );
  });
});

describe("parseAdManagerReport sparse-row fallbacks", () => {
  it("parses null rows, missing metric groups, and empty metric values as zeros", () => {
    const out = parseAdManagerReport({
      rows: [
        null,
        { dimensionValues: [{ stringValue: "2026-11-01" }] },
        {
          dimensionValues: [{ stringValue: "2026-11-02" }],
          metricValueGroups: [{ primaryValues: [{}] }],
        },
      ],
    });
    expect(out.parsed).toBe(true);
    expect(out.rows).toEqual([
      { dimensions: [], metrics: [] },
      { dimensions: ["2026-11-01"], metrics: [] },
      { dimensions: ["2026-11-02"], metrics: [0] },
    ]);
    // Short metric arrays count missing metrics as 0 in totals.
    expect(out.totals.AD_SERVER_IMPRESSIONS).toBe(0);
  });
});
