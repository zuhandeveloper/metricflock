import { google } from "googleapis";
import type { OAuth2Client } from "./auth-types";
import { GOOGLE_API_TIMEOUT_MS, withGoogleTimeout } from "./timeout";
// Typed parsers for GA4 Data API responses. No mocked data: every function calls the real client.
//
// The Data API is called over REST via googleapis — the same auth path
// as Search Console and AdSense. The @google-analytics/data gRPC client
// required bridging two google-auth-library copies through GoogleAuth;
// in production every GA4 call failed with INVALID_ARGUMENT while the
// REST providers worked with the same token, so the bridge is gone.
export type Ga4Client = ReturnType<typeof google.analyticsdata>;
export function getGa4Client(auth: OAuth2Client): Ga4Client {
  return google.analyticsdata({ version: "v1beta", auth });
}
export type RowLike = {
  dimensionValues?: { value?: string | null }[] | null;
  metricValues?: { value?: string | null }[] | null;
};
export function parseRealtimeRows(rows: RowLike[] | null | undefined, dimCount: number) {
  return (rows ?? []).map((r) => ({
    dimensions: (r.dimensionValues ?? []).slice(0, dimCount).map((d) => d.value ?? ""),
    activeUsers: Number(r.metricValues?.[0]?.value ?? 0),
  }));
}
/** Totals from a DIMENSION-LESS realtime query: the single returned row is
 *  the provider's true total (DATA-1). Summing multi-dimension rows would
 *  count one user once per dimension combination (e.g. per page viewed). */
export function parseRealtimeTotals(rows: RowLike[] | null | undefined) {
  const row = (rows ?? [])[0];
  return {
    activeUsers: Number(row?.metricValues?.[0]?.value ?? 0),
    eventCount: Number(row?.metricValues?.[1]?.value ?? 0),
  };
}
/** Top-10 breakdown from a SINGLE-dimension realtime query: each row is a
 *  distinct dimension value, so values are exact per value (DATA-1). */
export function parseRealtimeBreakdown(rows: RowLike[] | null | undefined) {
  return (rows ?? [])
    .map((r) => ({
      name: r.dimensionValues?.[0]?.value ?? "(not set)",
      activeUsers: Number(r.metricValues?.[0]?.value ?? 0),
    }))
    .sort((a, b) => b.activeUsers - a.activeUsers)
    .slice(0, 10);
}
export function parseReportRows(rows: RowLike[] | null | undefined, metrics: string[]) {
  return (rows ?? []).map((r) => {
    const out: Record<string, string | number> = {};
    (r.dimensionValues ?? []).forEach((d, i) => {
      out[`dimension${i}`] = d.value ?? "";
    });
    metrics.forEach((m, i) => {
      out[m] = Number(r.metricValues?.[i]?.value ?? 0);
    });
    return out;
  });
}
const REALTIME_BREAKDOWN_DIMENSIONS = [
  "country",
  "city",
  "deviceCategory",
  "browser",
  "operatingSystem",
  "unifiedPagePathScreen",
  // NOTE: session-scoped dimensions (sessionDefaultChannelGroup etc.) are
  // NOT valid in realtime reports — Google rejects the whole request with
  // INVALID_ARGUMENT. "platform" (web/iOS/Android) is the realtime-safe
  // traffic split.
  "platform",
] as const;

export async function runRealtimeReport(client: Ga4Client, propertyId: string) {
  // DATA-1: the total must come from a dimension-less query — summing a
  // multi-dimension report counts one user once per dimension combination.
  // Each breakdown likewise gets its own single-dimension query so per-value
  // counts are exact. (8 small realtime queries instead of 1 inflated one.)
  const property = `properties/${propertyId}`;
  // A-GGL-03: every Data API call is bounded — a hung Google endpoint
  // fails fast with GOOGLE_API_TIMEOUT instead of hanging the request.
  const timed = <T>(p: Promise<T>, op: string) => withGoogleTimeout(p, `ga4.${op}`);
  const opts = { timeout: GOOGLE_API_TIMEOUT_MS };
  const [totalsRes, ...breakdownRes] = await Promise.all([
    timed(
      client.properties.runRealtimeReport(
        {
          property,
          requestBody: { metrics: [{ name: "activeUsers" }, { name: "eventCount" }] },
        },
        opts,
      ),
      "runRealtimeReport.totals",
    ),
    ...REALTIME_BREAKDOWN_DIMENSIONS.map((name) =>
      timed(
        client.properties.runRealtimeReport(
          {
            property,
            requestBody: { dimensions: [{ name }], metrics: [{ name: "activeUsers" }] },
          },
          opts,
        ),
        `runRealtimeReport.${name}`,
      ),
    ),
  ]);
  const totals = totalsRes.data;
  const { activeUsers, eventCount } = parseRealtimeTotals((totals.rows ?? []) as RowLike[]);
  const by = (i: number) => parseRealtimeBreakdown((breakdownRes[i]?.data.rows ?? []) as RowLike[]);
  return {
    propertyId,
    activeUsers,
    byCountry: by(0),
    byCity: by(1),
    byDevice: by(2),
    byBrowser: by(3),
    byOperatingSystem: by(4),
    byPage: by(5),
    byPlatform: by(6),
    eventCount,
    rowCount: totals.rowCount ? Number(totals.rowCount) : (totals.rows ?? []).length,
    // GA4 realtime is a sampled near-real-time window, not an exact live-session census.
    reportingWindow: "Last 30 minutes (GA4 realtime, approximate)",
  };
}
export const GA4_CORE_METRICS = [
  "totalUsers",
  "activeUsers",
  "newUsers",
  "sessions",
  "screenPageViews",
  "engagedSessions",
  "engagementRate",
  "averageEngagementTime",
  "bounceRate",
  "eventCount",
  "keyEvents",
  "sessionConversionRate",
];
/** Summary from the provider's TOTAL aggregation row. A missing totals row
 *  yields null per metric — never 0, which would be indistinguishable from
 *  real zero traffic (DATA-8). */
export function parseHistoricalSummary(
  totalsRow: RowLike | null | undefined,
  metrics: string[],
): Record<string, number | null> {
  const summary: Record<string, number | null> = {};
  metrics.forEach((m, i) => {
    const v = totalsRow?.metricValues?.[i]?.value;
    summary[m] = v === undefined || v === null ? null : Number(v);
  });
  return summary;
}

export type SamplingInfo = {
  sampled: boolean;
  samplesReadCount: number | null;
  samplingSpaceSize: number | null;
  subjectToThresholding: boolean;
  dataLossFromOtherRow: boolean;
};

/** DATA-7: surface GA4 sampling/thresholding instead of presenting sampled
 *  numbers as exact. */
export function parseSamplingMetadata(
  metadata:
    | {
        samplingMetadatas?:
          | {
              samplesReadCount?: string | number | { toString(): string } | null;
              samplingSpaceSize?: string | number | { toString(): string } | null;
            }[]
          | null;
        subjectToThresholding?: boolean | null;
        dataLossFromOtherRow?: boolean | null;
      }
    | null
    | undefined,
): SamplingInfo {
  const sm = metadata?.samplingMetadatas?.[0];
  const samplesReadCount = sm?.samplesReadCount != null ? Number(String(sm.samplesReadCount)) : null;
  const samplingSpaceSize = sm?.samplingSpaceSize != null ? Number(String(sm.samplingSpaceSize)) : null;
  return {
    sampled: samplesReadCount !== null && samplingSpaceSize !== null ? samplesReadCount < samplingSpaceSize : false,
    samplesReadCount,
    samplingSpaceSize,
    subjectToThresholding: metadata?.subjectToThresholding === true,
    dataLossFromOtherRow: metadata?.dataLossFromOtherRow === true,
  };
}

export async function runHistoricalReport(
  client: Ga4Client,
  propertyId: string,
  startDate: string,
  endDate: string,
  dimensions: { name: string }[] = [{ name: "date" }],
  metrics: string[] = GA4_CORE_METRICS,
) {
  const res = await withGoogleTimeout(
    client.properties.runReport(
      {
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions,
          metrics: metrics.map((name) => ({ name })),
          // DATA-8: ask the provider for the TOTAL aggregation so the summary
          // comes from GA4, not from summing (possibly truncated) detail rows.
          metricAggregations: ["TOTAL"],
        },
      },
      { timeout: GOOGLE_API_TIMEOUT_MS },
    ),
    "ga4.runReport",
  );
  const data = res.data;
  const totals = (data.totals ?? [])[0] as RowLike | undefined;
  const rows = parseReportRows((data.rows ?? []) as RowLike[], metrics);
  const rowCount = data.rowCount ? Number(data.rowCount) : 0;
  return {
    propertyId,
    startDate,
    endDate,
    summary: parseHistoricalSummary(totals, metrics),
    rows,
    rowCount,
    // F-3.3: GA4 caps detail rows (10k default); flag when the returned
    // rows are a prefix of the full result so callers never treat a
    // truncated detail set as complete. Totals come from the TOTAL
    // aggregation above and are unaffected.
    truncated: rowCount > rows.length,
    sampling: parseSamplingMetadata(data.metadata),
  };
}
export async function runTrafficAcquisition(client: Ga4Client, propertyId: string, startDate: string, endDate: string) {
  return runHistoricalReport(
    client,
    propertyId,
    startDate,
    endDate,
    [{ name: "sessionDefaultChannelGroup" }, { name: "sessionSourceMedium" }, { name: "sessionCampaignName" }],
    ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents"],
  );
}
export async function runAudienceReport(client: Ga4Client, propertyId: string, startDate: string, endDate: string) {
  const [country] = await Promise.all([
    runHistoricalReport(
      client,
      propertyId,
      startDate,
      endDate,
      [
        { name: "country" },
        { name: "city" },
        { name: "language" },
        { name: "deviceCategory" },
        { name: "browser" },
        { name: "operatingSystem" },
        { name: "newVsReturning" },
      ],
      ["activeUsers", "sessions", "engagedSessions"],
    ),
  ]);
  return country;
}
export async function runPagesReport(client: Ga4Client, propertyId: string, startDate: string, endDate: string) {
  // Article/author/category dimensions are custom dimensions; they only return data
  // when configured in the GA4 property. We request standard page dimensions here.
  return runHistoricalReport(
    client,
    propertyId,
    startDate,
    endDate,
    [{ name: "pagePath" }, { name: "landingPage" }],
    ["screenPageViews", "activeUsers", "engagedSessions", "averageEngagementTime"],
  );
}
export async function runEventsReport(client: Ga4Client, propertyId: string, startDate: string, endDate: string) {
  return runHistoricalReport(
    client,
    propertyId,
    startDate,
    endDate,
    [{ name: "eventName" }],
    ["eventCount", "totalUsers", "keyEvents"],
  );
}
