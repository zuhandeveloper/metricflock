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
        dimensions: ["DATE", "AD_UNIT_NAME"],
        metrics: ["AD_SERVER_IMPRESSIONS", "AD_SERVER_CLICKS", "AD_SERVER_CTR", "TOTAL_REVENUE"],
        dateRange: { startDate: toParts(startDate), endDate: toParts(endDate) },
      },
    }),
  });
  return {
    networkCode,
    startDate,
    endDate,
    report,
    note: "Ad Manager reporting via the Ad Manager REST API v1; verify the report shape against your network's API version.",
  };
}
