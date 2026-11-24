import { google } from "googleapis";
import type { OAuth2Client } from "./auth-types";
import { GOOGLE_API_TIMEOUT_MS, withGoogleTimeout } from "./timeout";

// Discovery listing with real pagination (F-3.3): every list call follows
// nextPageToken up to a page cap, guards against token loops, and reports
// `truncated` when the cap cut results short — a partial list is never
// silently presented as complete. GA4 isolates per-account failures so
// one broken account cannot hide every other account's properties.
const MAX_PAGES = 10;

export type DiscoveryResult<T> = { items: T[]; truncated: boolean };

async function paginate<T>(
  fetchPage: (pageToken: string | undefined) => Promise<{ items: T[]; nextPageToken?: string | null }>,
): Promise<DiscoveryResult<T>> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchPage(pageToken);
    items.push(...res.items);
    const next = res.nextPageToken ?? undefined;
    if (!next) return { items, truncated: false };
    if (seenTokens.has(next)) return { items, truncated: true }; // loop guard
    seenTokens.add(next);
    pageToken = next;
  }
  return { items, truncated: true }; // page cap reached with more available
}

export type Ga4DiscoveredProperty = { propertyId: string; displayName?: string; accountId?: string };

export async function listGa4Properties(
  auth: OAuth2Client,
): Promise<DiscoveryResult<Ga4DiscoveredProperty> & { errors: string[] }> {
  const admin = google.analyticsadmin({ version: "v1beta", auth });
  const opts = { timeout: GOOGLE_API_TIMEOUT_MS };
  const accounts = await paginate(async (pageToken) => {
    // A-GGL-03: bounded like every other googleapis call (see timeout.ts).
    const res = await withGoogleTimeout(
      admin.accounts.list({ pageSize: 200, pageToken }, opts),
      "discovery.ga4.accounts.list",
    );
    return { items: res.data.accounts ?? [], nextPageToken: res.data.nextPageToken };
  });
  const out: Ga4DiscoveredProperty[] = [];
  const errors: string[] = [];
  let truncated = accounts.truncated;
  for (const acc of accounts.items) {
    try {
      const props = await paginate(async (pageToken) => {
        const res = await withGoogleTimeout(
          admin.properties.list({ filter: `parent:${acc.name}`, pageSize: 200, pageToken }, opts),
          "discovery.ga4.properties.list",
        );
        return { items: res.data.properties ?? [], nextPageToken: res.data.nextPageToken };
      });
      if (props.truncated) truncated = true;
      for (const p of props.items) {
        out.push({
          propertyId: p.name?.replace("properties/", "") ?? "",
          displayName: p.displayName ?? undefined,
          accountId: acc.name?.replace("accounts/", ""),
        });
      }
    } catch {
      // Per-account isolation: record and continue with other accounts.
      errors.push(acc.name ?? "unknown-account");
    }
  }
  return { items: out, truncated, errors };
}

export async function listSearchConsoleSites(auth: OAuth2Client) {
  const sc = google.searchconsole({ version: "v1", auth });
  const res = await withGoogleTimeout(
    sc.sites.list(undefined, { timeout: GOOGLE_API_TIMEOUT_MS }),
    "discovery.search-console.sites.list",
  );
  // The Search Console sites.list API has no pagination — one call is complete.
  return {
    items: (res.data.siteEntry ?? []).map((s) => ({
      siteUrl: s.siteUrl ?? "",
      permissionLevel: s.permissionLevel ?? undefined,
    })),
    truncated: false,
  };
}

export async function listAdSenseAccounts(auth: OAuth2Client) {
  const adsense = google.adsense({ version: "v2", auth });
  const result = await paginate(async (pageToken) => {
    const res = await withGoogleTimeout(
      adsense.accounts.list({ pageSize: 50, pageToken }, { timeout: GOOGLE_API_TIMEOUT_MS }),
      "discovery.adsense.accounts.list",
    );
    return { items: res.data.accounts ?? [], nextPageToken: res.data.nextPageToken };
  });
  return {
    items: result.items.map((a) => ({
      accountId: a.name?.replace("accounts/", "") ?? "",
      displayName: a.displayName ?? undefined,
    })),
    truncated: result.truncated,
  };
}
