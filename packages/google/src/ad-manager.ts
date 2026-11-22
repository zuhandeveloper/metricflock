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
async function admFetch(auth: OAuth2Client, path: string, init?: RequestInit) {
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error("AD_MANAGER_NO_ACCESS_TOKEN");
  const res = await fetch(`https://admanager.googleapis.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AD_MANAGER_API_ERROR_${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}
export async function listAdManagerNetworks(auth: OAuth2Client) {
  if (!adManagerEnabled()) throw new Error("AD_MANAGER_DISABLED");
  const data = await admFetch(auth, "/networks?pageSize=50");
  const networks = (data.networks ?? []) as { networkCode?: string; displayName?: string }[];
  return networks.map((n) => ({ networkCode: n.networkCode ?? "", displayName: n.displayName ?? undefined }));
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
  return { parsed: true, rows, totals };
}

export async function runAdManagerReport(auth: OAuth2Client, networkCode: string, startDate: string, endDate: string) {
  if (!adManagerEnabled()) throw new Error("AD_MANAGER_DISABLED");
  const toParts = (d: string) => ({
    year: Number(d.slice(0, 4)),
    month: Number(d.slice(5, 7)),
    day: Number(d.slice(8, 10)),
  });
  const report = await admFetch(auth, `/networks/${networkCode}/reports:run`, {
    method: "POST",
    body: JSON.stringify({
      report: {
        dimensions: [...AD_MANAGER_DIMENSIONS],
        metrics: [...AD_MANAGER_METRICS],
        dateRange: { startDate: toParts(startDate), endDate: toParts(endDate) },
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
      ? "Ad Manager reporting via the Ad Manager REST API v1; totals are summed from the returned rows."
      : "Ad Manager returned a report shape this parser does not recognize; no metrics were derived from it. Verify the shape against your network's API version.",
  };
}
