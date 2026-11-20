import { NextResponse } from "next/server";
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
export function resolveRange(
  range: string,
  startDate?: string,
  endDate?: string,
): { startDate: string; endDate: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const days = { today: 0, yesterday: 1, "7d": 7, "28d": 28, "90d": 90, "12m": 365 } as Record<string, number>;
  if (range === "custom" && startDate && endDate) return { startDate, endDate };
  const n = days[range] ?? 28;
  const end = range === "yesterday" ? new Date(today.getTime() - 86400000) : today;
  const start = new Date(end.getTime() - (n === 0 ? 0 : n - 1) * 86400000);
  return { startDate: fmt(start), endDate: fmt(end) };
}
