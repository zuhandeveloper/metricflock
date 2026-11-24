import type { OAuth2Client } from "./auth-types";
// Google Ad Manager integration is OPTIONAL (GOOGLE_AD_MANAGER_ENABLED=false by default).
// NOTE: the `googleapis` npm package (v169+) ships NO Ad Manager client
// (`google.admanager` is undefined), so this module calls the Ad Manager REST
// API directly (https://admanager.googleapis.com/v1) with the user's OAuth2
// access token. Ad Manager != AdSense.
//
// Reporting follows the documented v1 flow (A-GGL-01; see
// developers.google.com/ad-manager/api/beta/reports):
//   1. POST /v1/networks/{networkCode}/reports — create a Report
//      (reportDefinition: dimensions, metrics, fixed date range,
//      reportType HISTORICAL) → report resource name.
//   2. POST /v1/{reportName}:run — run the existing report → a
//      long-running Operation.
//   3. GET /v1/{operationName} — poll until done (bounded total wait).
//      A completed Operation carries response.reportResult, the Result
//      resource name; a failed one carries error.
//   4. GET /v1/{resultName}:fetchRows — paginated rows. Each row has
//      dimensionValues (stringValue/intValue/...) and metricValueGroups
//      whose primaryValues hold intValue/doubleValue/microsValue.
// There is no synchronous `reports:run` with an inline definition and no
// inline `rows` response — the previous implementation called that
// non-existent shape and could never return data.
//
// LIVE STATUS: this flow is implemented against Google's published REST
// reference and exercised against recorded fixtures in
// apps/web/tests/unit/ad-manager-flow.test.ts. It has NOT yet been run
// against a real Ad Manager network — verify against a live network
// before claiming support.
export function adManagerEnabled(): boolean {
  return process.env.GOOGLE_AD_MANAGER_ENABLED === "true";
}

const ADM_TIMEOUT_MS = 15_000;
const ADM_MAX_ATTEMPTS = 3;
// Bounded poll for the report Operation: a report run must finish well
// inside the analytics route's 60 s maxDuration (row 9) and the worker's
// per-job budget. Tests override both via runAdManagerReport opts.
const ADM_POLL_TIMEOUT_MS = 45_000;
const ADM_POLL_INTERVAL_MS = 2_000;
const ADM_FETCH_ROWS_PAGE_SIZE = 1000;
const ADM_FETCH_ROWS_MAX_PAGES = 10;
const admSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ad Manager REST call with a hard timeout and bounded retries on
 * transient failures (429 / 5xx / network) — F-3.4. Non-transient 4xx
 * fail immediately. Backoff is exponential with jitter. */
async function admFetch(auth: OAuth2Client, path: string, init?: RequestInit) {
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error("AD_MANAGER_NO_ACCESS_TOKEN");
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= ADM_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ADM_TIMEOUT_MS);
    try {
      const res = await fetch(`https://admanager.googleapis.com/v1${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      const text = await res.text().catch(() => "");
      const err = new Error(`AD_MANAGER_API_ERROR_${res.status}: ${text.slice(0, 200)}`);
      if (res.status !== 429 && res.status < 500) throw err; // non-transient
      lastError = err;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("AD_MANAGER_API_ERROR_")) throw e;
      lastError = e instanceof Error ? e : new Error(String(e)); // network/abort → retryable
    } finally {
      clearTimeout(timer);
    }
    if (attempt < ADM_MAX_ATTEMPTS) await admSleep(500 * 2 ** (attempt - 1) + Math.random() * 250);
  }
  throw lastError ?? new Error("AD_MANAGER_API_ERROR_UNKNOWN");
}

export async function listAdManagerNetworks(auth: OAuth2Client) {
  if (!adManagerEnabled()) throw new Error("AD_MANAGER_DISABLED");
  // Paginated (F-3.3): follow nextPageToken with a cap + loop guard.
  const out: { networkCode: string; displayName?: string }[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ pageSize: "50", ...(pageToken ? { pageToken } : {}) });
    const data = await admFetch(auth, `/networks?${qs.toString()}`);
    const networks = (data.networks ?? []) as { networkCode?: string; displayName?: string }[];
    for (const n of networks) out.push({ networkCode: n.networkCode ?? "", displayName: n.displayName ?? undefined });
    const next = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!next || seen.has(next)) break;
    seen.add(next);
    pageToken = next;
  }
  return out;
}
export const AD_MANAGER_DIMENSIONS = ["DATE", "AD_UNIT_NAME"] as const;
export const AD_MANAGER_METRICS = [
  "AD_SERVER_IMPRESSIONS",
  "AD_SERVER_CLICKS",
  "AD_SERVER_CTR",
  "TOTAL_REVENUE",
] as const;

export type AdManagerRow = { dimensions: string[]; metrics: number[] };

type DimensionValue = {
  stringValue?: string | null;
  intValue?: string | number | null;
  doubleValue?: number | null;
  dateValue?: { year?: number; month?: number; day?: number } | null;
  // Legacy shape used by the pre-v1 parser (kept so old fixtures and
  // stored payloads still parse): a plain `value` field.
  value?: string | number | null;
};

type MetricValue = {
  intValue?: string | number | null;
  doubleValue?: number | null;
  // Currency metrics (e.g. TOTAL_REVENUE) arrive in micros: 1 unit =
  // 1,000,000 micros. Converted to units here so totals are currency.
  microsValue?: string | number | null;
  value?: string | number | null;
};

/** A dimension value in the real fetchRows shape: DATE dimensions arrive
 * as a date object or an ISO string; identifiers as intValue; names as
 * stringValue. */
function dimensionToString(d: DimensionValue): string {
  if (d.stringValue != null) return d.stringValue;
  if (d.intValue != null) return String(d.intValue);
  if (d.doubleValue != null) return String(d.doubleValue);
  if (d.dateValue) {
    const { year, month, day } = d.dateValue;
    if (year != null && month != null && day != null) {
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  if (d.value != null) return String(d.value);
  return "";
}

function metricToNumber(m: MetricValue): number {
  if (m.intValue != null) return Number(m.intValue);
  if (m.doubleValue != null) return Number(m.doubleValue);
  if (m.microsValue != null) return Number(m.microsValue) / 1_000_000;
  return Number(m.value ?? 0);
}

function totalsFromRows(rows: AdManagerRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  AD_MANAGER_METRICS.forEach((name, i) => {
    totals[name] = rows.reduce((s, r) => s + (r.metrics[i] ?? 0), 0);
  });
  // F-3.4: CTR is a ratio — summing per-row CTRs is meaningless. Recompute
  // the total CTR from total clicks / total impressions (0 when no
  // impressions). Metric order is AD_MANAGER_METRICS (impressions, clicks, ctr, revenue).
  const impressions = totals.AD_SERVER_IMPRESSIONS ?? 0;
  const clicks = totals.AD_SERVER_CLICKS ?? 0;
  totals.AD_SERVER_CTR = impressions > 0 ? clicks / impressions : 0;
  return totals;
}

/** Typed parser for Ad Manager `fetchRows` rows (DATA-9). The real v1
 * shape is `{ rows: [{ dimensionValues: [{stringValue|intValue|...}],
 * metricValueGroups: [{ primaryValues: [{intValue|doubleValue|
 * microsValue}] }] }] }` — one MetricValueGroup per row when the report
 * has no date-range comparison or split. The legacy `{value}` shape is
 * still accepted defensively. An unrecognized shape yields
 * `parsed: false` with empty rows — numbers are never invented. */
export function parseAdManagerReport(report: unknown): {
  parsed: boolean;
  rows: AdManagerRow[];
  totals: Record<string, number>;
} {
  const raw = (report ?? {}) as Record<string, unknown>;
  const candidateRows =
    (raw.rows as unknown[] | undefined) ??
    ((raw.result as Record<string, unknown> | undefined)?.rows as unknown[] | undefined) ??
    ((raw.report as Record<string, unknown> | undefined)?.rows as unknown[] | undefined);
  if (!Array.isArray(candidateRows)) return { parsed: false, rows: [], totals: {} };
  const rows: AdManagerRow[] = candidateRows.map((r) => {
    const row = (r ?? {}) as {
      dimensionValues?: DimensionValue[];
      metricValues?: MetricValue[];
      metricValueGroups?: { primaryValues?: MetricValue[] }[];
    };
    // Real shape: metrics live in the first MetricValueGroup's
    // primaryValues (one group when there is no comparison/split).
    // Legacy shape: a flat metricValues array.
    const metricValues = row.metricValueGroups?.[0]?.primaryValues ?? row.metricValues ?? [];
    return {
      dimensions: (row.dimensionValues ?? []).map(dimensionToString),
      metrics: metricValues.map(metricToNumber),
    };
  });
  return { parsed: true, rows, totals: totalsFromRows(rows) };
}

/** Strict YYYY-MM-DD validation (F-3.4): rejects malformed strings and
 * impossible dates before any API call, instead of slicing NaNs into the
 * request. */
export function parseAdManagerDate(d: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error("AD_MANAGER_INVALID_DATE");
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new Error("AD_MANAGER_INVALID_DATE");
  }
  return { year, month, day };
}

export async function runAdManagerReport(
  auth: OAuth2Client,
  networkCode: string,
  startDate: string,
  endDate: string,
  opts: { pollTimeoutMs?: number; pollIntervalMs?: number } = {},
) {
  if (!adManagerEnabled()) throw new Error("AD_MANAGER_DISABLED");
  const start = parseAdManagerDate(startDate);
  const end = parseAdManagerDate(endDate);
  if (startDate > endDate) throw new Error("AD_MANAGER_INVALID_DATE");
  const pollTimeoutMs = opts.pollTimeoutMs ?? ADM_POLL_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? ADM_POLL_INTERVAL_MS;

  // 1. Create the report definition (fixed date range, HISTORICAL).
  const created = await admFetch(auth, `/networks/${networkCode}/reports`, {
    method: "POST",
    body: JSON.stringify({
      report: {
        displayName: `MetricFlock ${startDate} to ${endDate}`,
        reportDefinition: {
          dimensions: [...AD_MANAGER_DIMENSIONS],
          metrics: [...AD_MANAGER_METRICS],
          dateRange: { fixed: { startDate: start, endDate: end } },
          reportType: "HISTORICAL",
        },
      },
    }),
  });
  const reportName = typeof created.name === "string" ? created.name : "";
  if (!reportName) throw new Error("AD_MANAGER_REPORT_CREATE_FAILED: create returned no report name");

  // 2. Run the existing report → long-running Operation.
  let operation = await admFetch(auth, `/${reportName}:run`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  const operationName = typeof operation.name === "string" ? operation.name : "";
  if (!operationName) throw new Error("AD_MANAGER_REPORT_RUN_FAILED: run returned no operation name");

  // 3. Poll the Operation until done, bounded (A-GGL-03: never hang).
  const deadline = Date.now() + pollTimeoutMs;
  while (!operation.done) {
    if (Date.now() > deadline) {
      throw new Error(
        `AD_MANAGER_REPORT_TIMEOUT: report run ${operationName} did not complete within ${pollTimeoutMs}ms`,
      );
    }
    await admSleep(pollIntervalMs);
    operation = await admFetch(auth, `/${operationName}`);
  }
  const opError = operation.error as { message?: string; status?: string; code?: number } | undefined;
  if (opError) {
    throw new Error(
      `AD_MANAGER_REPORT_FAILED: ${[opError.status ?? opError.code ?? "", opError.message ?? "report run failed"]
        .filter(Boolean)
        .join(" ")}`.trim(),
    );
  }
  const response = (operation.response ?? {}) as Record<string, unknown>;
  const resultName = typeof response.reportResult === "string" ? response.reportResult : "";
  if (!resultName) {
    throw new Error("AD_MANAGER_REPORT_FAILED: completed operation returned no report result");
  }

  // 4. Fetch rows, paginated. A result with no rows at all omits `rows`;
  // that is a valid empty report, not an unrecognized shape.
  const rows: AdManagerRow[] = [];
  let totalRowCount: number | null = null;
  let pageToken: string | undefined;
  for (let page = 0; page < ADM_FETCH_ROWS_MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      pageSize: String(ADM_FETCH_ROWS_PAGE_SIZE),
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await admFetch(auth, `/${resultName}:fetchRows?${qs.toString()}`);
    const pageData = data.rows === undefined ? { rows: [] } : data;
    const { parsed, rows: pageRows } = parseAdManagerReport(pageData);
    if (!parsed) {
      throw new Error("AD_MANAGER_REPORT_UNRECOGNIZED_SHAPE: fetchRows returned rows this parser does not recognize");
    }
    rows.push(...pageRows);
    if (typeof data.totalRowCount === "number") totalRowCount = data.totalRowCount;
    const next = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
    if (!next) break;
    pageToken = next;
  }
  return {
    networkCode,
    startDate,
    endDate,
    dimensions: [...AD_MANAGER_DIMENSIONS],
    metrics: [...AD_MANAGER_METRICS],
    parsed: true,
    rows,
    totals: totalsFromRows(rows),
    totalRowCount,
    truncated: totalRowCount !== null && totalRowCount > rows.length,
    note: "Ad Manager reporting via the Ad Manager REST API v1 (create → run → poll Operation → fetchRows); totals are summed from the returned rows, CTR recomputed from total clicks/impressions. Not yet verified against a live network.",
  };
}
