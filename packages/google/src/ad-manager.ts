import type { OAuth2Client } from "./auth-types";
// Google Ad Manager integration is OPTIONAL (GOOGLE_AD_MANAGER_ENABLED=false by default).
// NOTE: the `googleapis` npm package (v169) ships NO Ad Manager client
// (`google.admanager` is undefined), so this module calls the Ad Manager REST
// API directly (https://admanager.googleapis.com/v1) with the user's OAuth2
// access token. If Google changes the surface, this module fails loudly with
// a clear error rather than returning invented metrics. Ad Manager != AdSense.
export function adManagerEnabled(): boolean {
  return process.env.GOOGLE_AD_MANAGER_ENABLED === "true";
}

const ADM_TIMEOUT_MS = 15_000;
const ADM_MAX_ATTEMPTS = 3;
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

/** Typed parser for the Ad Manager REST report response (DATA-9). The REST
 *  v1 `reports:run` response carries rows of dimensionValues/metricValues;
 *  this parser extracts them defensively and computes per-metric totals
 *  from the rows. An unrecognized shape yields `parsed: false` with empty
 *  rows — numbers are never invented. NOTE: not yet verified against a
 *  real Ad Manager network (no live account connected); verify the shape
 *  against your network before claiming support. */
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
      dimensionValues?: { value?: string | null }[];
      metricValues?: { value?: string | number | null }[];
    };
    return {
      dimensions: (row.dimensionValues ?? []).map((d) => d.value ?? ""),
      metrics: (row.metricValues ?? []).map((m) => Number(m.value ?? 0)),
    };
  });
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
  return { parsed: true, rows, totals };
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

export async function runAdManagerReport(auth: OAuth2Client, networkCode: string, startDate: string, endDate: string) {
  if (!adManagerEnabled()) throw new Error("AD_MANAGER_DISABLED");
  const start = parseAdManagerDate(startDate);
  const end = parseAdManagerDate(endDate);
  if (startDate > endDate) throw new Error("AD_MANAGER_INVALID_DATE");
  const report = await admFetch(auth, `/networks/${networkCode}/reports:run`, {
    method: "POST",
    body: JSON.stringify({
      report: {
        dimensions: [...AD_MANAGER_DIMENSIONS],
        metrics: [...AD_MANAGER_METRICS],
        dateRange: { startDate: start, endDate: end },
      },
    }),
  });
  const { parsed, rows, totals } = parseAdManagerReport(report);
  return {
    networkCode,
    startDate,
    endDate,
    dimensions: [...AD_MANAGER_DIMENSIONS],
    metrics: [...AD_MANAGER_METRICS],
    parsed,
    rows,
    totals,
    note: parsed
      ? "Ad Manager reporting via the Ad Manager REST API v1 (beta — not yet verified against a live network); totals are summed from the returned rows, CTR recomputed from total clicks/impressions."
      : "Ad Manager returned a report shape this parser does not recognize; no metrics were derived from it. Verify the shape against your network's API version.",
  };
}
