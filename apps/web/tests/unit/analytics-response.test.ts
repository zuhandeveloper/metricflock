import { describe, expect, it } from "vitest";
import { analyticsEnvelope, notConnectedEnvelope, missingDataEnvelope, resolveRange } from "@/lib/analytics-response";
import { ApiError } from "@/lib/api-error";

describe("analytics response envelopes", () => {
  it("builds the ok envelope with defaults", async () => {
    const res = analyticsEnvelope({
      data: { sessions: 1 },
      includedWebsites: ["w1"],
      unavailableWebsites: [],
      dataSource: "snapshot",
      freshness: "snapshot",
      range: { startDate: "2026-10-26", endDate: "2026-11-22" },
    });
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.lastSyncedAt).toBeNull();
    expect(body.includedWebsites).toEqual(["w1"]);
  });

  it("builds not_connected and missing_data envelopes", async () => {
    const nc = await notConnectedEnvelope("w1").json();
    expect(nc.status).toBe("not_connected");
    expect(nc.unavailableWebsites[0].websiteId).toBe("w1");
    const md = await missingDataEnvelope("w2", "no_snapshot_yet").json();
    expect(md.status).toBe("missing_data");
    expect(md.unavailableWebsites[0].reason).toBe("no_snapshot_yet");
  });
});

describe("resolveRange", () => {
  it("resolves presets and custom; rejects unknown ranges (A-API-03)", () => {
    const r28 = resolveRange("28d");
    const days = (Date.parse(r28.endDate) - Date.parse(r28.startDate)) / 86_400_000;
    expect(days).toBe(27);
    expect(resolveRange("custom", "2026-01-01", "2026-01-31")).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    // A-API-03: an unknown range is a client error (400 invalid_range),
    // never a silent fallback to 28d — wrong-date data is worse than an error.
    expect(() => resolveRange("nonsense")).toThrowError(ApiError);
    try {
      resolveRange("nonsense");
      expect.unreachable("unknown range must throw");
    } catch (e) {
      expect((e as ApiError).code).toBe("invalid_range");
      expect((e as ApiError).status).toBe(400);
    }
    expect(() => resolveRange("custom")).toThrowError(ApiError);
    expect(() => resolveRange("custom", "2026-01-01")).toThrowError(ApiError);
    const today = resolveRange("today");
    expect(today.startDate).toBe(today.endDate);
    const yesterday = resolveRange("yesterday");
    expect(yesterday.startDate).toBe(yesterday.endDate);
    expect(yesterday.endDate < today.endDate).toBe(true);
  });

  it("rejects impossible custom dates and inverted ranges (A-GGL-08)", () => {
    // A format regex admits these; only a calendar check catches them.
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-5"]) {
      expect(() => resolveRange("custom", bad, "2026-02-28")).toThrowError(ApiError);
      expect(() => resolveRange("custom", "2026-02-01", bad)).toThrowError(ApiError);
    }
    try {
      resolveRange("custom", "2026-02-30", "2026-03-01");
      expect.unreachable("impossible date must throw");
    } catch (e) {
      expect((e as ApiError).code).toBe("invalid_range");
      expect((e as ApiError).status).toBe(400);
    }
    // startDate after endDate is a client error, not an empty fetch.
    expect(() => resolveRange("custom", "2026-02-10", "2026-02-01")).toThrowError(ApiError);
    // A real leap day still passes.
    expect(resolveRange("custom", "2024-02-29", "2024-03-01")).toEqual({
      startDate: "2024-02-29",
      endDate: "2024-03-01",
    });
  });
});
