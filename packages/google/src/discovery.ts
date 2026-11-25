import { google } from "googleapis";
import type { OAuth2Client } from "./auth-types";
import { GOOGLE_API_TIMEOUT_MS, withGoogleTimeout } from "./timeout";

// Discovery listing with real pagination (F-3.3): every list call follows
// nextPageToken up to a page cap, guards against token loops, and reports
// `truncated` when the cap cut results short — a partial list is never
// silently presented as complete. GA4 isolates per-account failures so
// one broken account cannot hide every other account's properties.
//
// A-API-13: the page cap alone does not bound volume — up to 10 pages x
// 200 accounts, each with up to 10 pages x 200 properties, listed
// sequentially with no overall timeout, then one DB upsert per property.
// One call against a large Google account could issue thousands of API
// calls and DB writes. So each list call is now bounded three ways:
// - at most MAX_DISCOVERED_ITEMS items returned (`truncated: true` when
//   the cap cut the listing short — pruning is already skipped on a
//   truncated listing, so no discovered row is ever deleted for a
//   property the cap hid);
// - at most MAX_GA4_ACCOUNTS accounts enumerated for GA4 (each account
//   costs at least one properties.list call even when it holds nothing);
// - an overall DISCOVERY_TIMEOUT_MS deadline per list call, checked
//   between pages and between accounts (per-call 15 s timeouts from
//   A-GGL-03 bound a single call, not the whole listing).
// The route itself is already rate-limited (A-API-05, `strict` tier:
// 20/min per user+route), so no wrapper change was needed there.
// Caps are owner-confirmable numbers: a single Google account with
// more than 200 Analytics accounts or 1,000 properties is far outside
// normal use, and the `truncated` flag surfaces the cut in the UI.
export const MAX_DISCOVERED_ITEMS = 1000;
export const MAX_GA4_ACCOUNTS = 200;
export const DISCOVERY_TIMEOUT_MS = 60_000;

const MAX_PAGES = 10;

export type DiscoveryResult<T> = { items: T[]; truncated: boolean };

export type DiscoveryOptions = { timeoutMs?: number };

async function paginate<T>(
  fetchPage: (pageToken: string | undefined) => Promise<{ items: T[]; nextPageToken?: string | null }>,
  opts: { maxItems?: number; deadline?: number } = {},
): Promise<DiscoveryResult<T>> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) return { items, truncated: true };
    const res = await fetchPage(pageToken);
    items.push(...res.items);
    const next = res.nextPageToken ?? undefined;
    if (opts.maxItems !== undefined && items.length >= opts.maxItems) {
      const sliced = items.slice(0, opts.maxItems);
      // Truncated only when the cap actually cut something off: more
      // items in this page than the cap, or another page behind the
      // token. A listing that lands exactly on the cap is complete.
      return { items: sliced, truncated: items.length > opts.maxItems || next !== undefined };
    }
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
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult<Ga4DiscoveredProperty> & { errors: string[] }> {
  const admin = google.analyticsadmin({ version: "v1beta", auth });
  const apiOpts = { timeout: GOOGLE_API_TIMEOUT_MS };
  const deadline = Date.now() + (opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  const accounts = await paginate(
    async (pageToken) => {
      // A-GGL-03: bounded like every other googleapis call (see timeout.ts).
      const res = await withGoogleTimeout(
        admin.accounts.list({ pageSize: 200, pageToken }, apiOpts),
        "discovery.ga4.accounts.list",
      );
      return { items: res.data.accounts ?? [], nextPageToken: res.data.nextPageToken };
    },
    { maxItems: MAX_GA4_ACCOUNTS, deadline },
  );
  const out: Ga4DiscoveredProperty[] = [];
  const errors: string[] = [];
  let truncated = accounts.truncated;
  for (const acc of accounts.items) {
    if (out.length >= MAX_DISCOVERED_ITEMS || Date.now() >= deadline) {
      truncated = true;
      break;
    }
    try {
      const props = await paginate(
        async (pageToken) => {
          const res = await withGoogleTimeout(
            admin.properties.list({ filter: `parent:${acc.name}`, pageSize: 200, pageToken }, apiOpts),
            "discovery.ga4.properties.list",
          );
          return { items: res.data.properties ?? [], nextPageToken: res.data.nextPageToken };
        },
        { maxItems: MAX_DISCOVERED_ITEMS - out.length, deadline },
      );
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
  const items = (res.data.siteEntry ?? []).map((s) => ({
    siteUrl: s.siteUrl ?? "",
    permissionLevel: s.permissionLevel ?? undefined,
  }));
  // A-API-13: a single response is still bounded, like every other list.
  return {
    items: items.slice(0, MAX_DISCOVERED_ITEMS),
    truncated: items.length > MAX_DISCOVERED_ITEMS,
  };
}

export async function listAdSenseAccounts(auth: OAuth2Client, opts: DiscoveryOptions = {}) {
  const adsense = google.adsense({ version: "v2", auth });
  const deadline = Date.now() + (opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  const result = await paginate(
    async (pageToken) => {
      const res = await withGoogleTimeout(
        adsense.accounts.list({ pageSize: 50, pageToken }, { timeout: GOOGLE_API_TIMEOUT_MS }),
        "discovery.adsense.accounts.list",
      );
      return { items: res.data.accounts ?? [], nextPageToken: res.data.nextPageToken };
    },
    { maxItems: MAX_DISCOVERED_ITEMS, deadline },
  );
  return {
    items: result.items.map((a) => ({
      accountId: a.name?.replace("accounts/", "") ?? "",
      displayName: a.displayName ?? undefined,
    })),
    truncated: result.truncated,
  };
}
