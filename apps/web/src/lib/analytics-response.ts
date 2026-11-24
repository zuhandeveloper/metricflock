import { NextResponse } from "next/server";
import { ApiError } from "./api-error";
export function analyticsEnvelope(opts: {
  data: unknown;
  websiteId?: string | null;
  includedWebsites: string[];
  unavailableWebsites: { websiteId: string; reason: string }[];
  lastSyncedAt?: string | null;
  dataSource: string;
  freshness: string;
  range: { startDate: string; endDate: string };
}) {
  return NextResponse.json({
    status: "ok",
    data: opts.data,
    includedWebsites: opts.includedWebsites,
    unavailableWebsites: opts.unavailableWebsites,
    lastSyncedAt: opts.lastSyncedAt ?? null,
    dataSource: opts.dataSource,
    freshness: opts.freshness,
    range: opts.range,
  });
}
export function notConnectedEnvelope(
  websiteId: string,
  reason = "No active Google connection for this website or its team.",
) {
  return NextResponse.json(
    {
      status: "not_connected",
      data: null,
      includedWebsites: [],
      unavailableWebsites: [{ websiteId, reason }],
      lastSyncedAt: null,
      dataSource: "google",
      freshness: "unavailable",
      range: null,
    },
    { status: 200 },
  );
}
export function missingDataEnvelope(websiteId: string, reason: string) {
  return NextResponse.json(
    {
      status: "missing_data",
      data: null,
      includedWebsites: [],
      unavailableWebsites: [{ websiteId, reason }],
      lastSyncedAt: null,
      dataSource: "google",
      freshness: "unavailable",
      range: null,
    },
    { status: 200 },
  );
}
/** Resolve a `range` query value to concrete dates. A-API-03: an
 *  unknown range — or `custom` without both valid dates — is a client
 *  error (400 `invalid_range`), never a silent fallback to 28 days:
 *  a typo'd range returning wrong-date data is worse than an error
 *  for an analytics product. Callers are wrapped in `withApiErrors`,
 *  which maps the thrown ApiError to the contract response. */
export function resolveRange(
  range: string,
  startDate?: string,
  endDate?: string,
): { startDate: string; endDate: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const days = { today: 0, yesterday: 1, "7d": 7, "28d": 28, "90d": 90, "12m": 365 } as Record<string, number>;
  const validDate = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (range === "custom") {
    if (!validDate(startDate) || !validDate(endDate)) {
      throw new ApiError("invalid_range", 400, {
        message: "range=custom requires valid startDate and endDate (YYYY-MM-DD).",
      });
    }
    return { startDate: startDate as string, endDate: endDate as string };
  }
  const n = days[range];
  if (n === undefined) {
    throw new ApiError("invalid_range", 400, {
      message: `range must be one of: ${Object.keys(days).join(", ")}, custom.`,
    });
  }
  const end = range === "yesterday" ? new Date(today.getTime() - 86400000) : today;
  const start = new Date(end.getTime() - (n === 0 ? 0 : n - 1) * 86400000);
  return { startDate: fmt(start), endDate: fmt(end) };
}
