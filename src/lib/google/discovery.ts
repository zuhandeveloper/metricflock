import { google } from "googleapis";
import type { OAuth2Client } from "@/lib/google/auth-types";
export async function listGa4Properties(auth: OAuth2Client) {
  const admin = google.analyticsadmin({ version: "v1beta", auth });
  const accounts = await admin.accounts.list({ pageSize: 200 });
  const out: { propertyId: string; displayName?: string; accountId?: string }[] = [];
  for (const acc of accounts.data.accounts ?? []) {
    const props = await admin.properties.list({ filter: `parent:${acc.name}`, pageSize: 200 });
    for (const p of props.data.properties ?? []) {
      out.push({ propertyId: p.name?.replace("properties/", "") ?? "", displayName: p.displayName ?? undefined, accountId: acc.name?.replace("accounts/", "") });
    }
  }
  return out;
}
export async function listSearchConsoleSites(auth: OAuth2Client) {
  const sc = google.searchconsole({ version: "v1", auth });
  const res = await sc.sites.list();
  return (res.data.siteEntry ?? []).map((s) => ({ siteUrl: s.siteUrl ?? "", permissionLevel: s.permissionLevel ?? undefined }));
}
export async function listAdSenseAccounts(auth: OAuth2Client) {
  const adsense = google.adsense({ version: "v2", auth });
  const res = await adsense.accounts.list({ pageSize: 50 });
  return (res.data.accounts ?? []).map((a) => ({ accountId: a.name?.replace("accounts/", "") ?? "", displayName: a.displayName ?? undefined }));
}
