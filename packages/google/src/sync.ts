// Worker sync engine (ADR-0005 option (a), implemented 2026-11-19).
//
// The BullMQ worker calls these functions to perform the REAL Google fetch:
// resolve the website/team connection, call the provider clients, write the
// same Redis cache keys the web dashboards read, and record integration
// health. The web API layer keeps serving live fetches on cache miss; this
// engine keeps the cache warm and proves connections healthy in background.
//
// Error contract (the worker relies on it):
// - Expected states (no connection, no mapping, Ad Manager disabled, revoked
//   grant) RETURN a SyncResult with a non-"ok" status — retrying cannot fix
//   them, so they must not burn BullMQ attempts.
// - Real Google API errors (quota, 5xx, network) THROW — the worker records
//   FAILED and BullMQ retries with exponential backoff.
// - Per-connection rate limiting throws SyncRateLimitError — the worker turns
//   it into BullMQ's RateLimitError so the job is delayed, not failed.
import { prisma } from "@metricflock/db";
import { recordHealth } from "@metricflock/db/health";
import { buildCacheKey, cacheSet, rateLimit } from "@metricflock/shared";
import { getAuthorizedClientForWebsite, getAuthorizedClientForIntegration, getPrimaryIntegration } from "./client";
import {
  getGa4Client,
  runRealtimeReport,
  runHistoricalReport,
  runTrafficAcquisition,
  runAudienceReport,
  runPagesReport,
  runEventsReport,
} from "./ga4";
import { querySearchAnalytics } from "./search-console";
import { runAdSenseReport } from "./adsense";
import { runAdManagerReport, adManagerEnabled, listAdManagerNetworks } from "./ad-manager";
import { listGa4Properties, listSearchConsoleSites, listAdSenseAccounts } from "./discovery";
import { getValidAccessToken } from "./tokens";
import { getOAuthClient } from "./oauth";
import type { OAuth2Client } from "./auth-types";

export type SyncKind =
  "ga4-realtime" | "ga4-historical" | "search-console" | "adsense" | "ad-manager" | "health-check" | "cache-refresh";
export type SyncStatus = "ok" | "skipped" | "not_connected" | "no_mapping" | "disabled";
export type SyncResult = { status: SyncStatus; reports: string[]; detail?: string };

export class SyncRateLimitError extends Error {
  constructor(connectionId: string) {
    super(`SYNC_RATE_LIMITED:${connectionId}`);
    this.name = "SyncRateLimitError";
  }
}

/** Injectable dependencies — defaults are the real modules; tests pass fakes
 *  (spec §23: mocked Google clients for automated tests). */
export type SyncDeps = {
  getAuthorizedClientForWebsite: typeof getAuthorizedClientForWebsite;
  getAuthorizedClientForIntegration: typeof getAuthorizedClientForIntegration;
  getPrimaryIntegration: typeof getPrimaryIntegration;
  getWebsiteOrganizationId: (websiteId: string) => Promise<string>;
  cacheSet: typeof cacheSet;
  recordHealth: typeof recordHealth;
  rateLimit: typeof rateLimit;
  ga4: {
    getGa4Client: typeof getGa4Client;
    runRealtimeReport: typeof runRealtimeReport;
    runHistoricalReport: typeof runHistoricalReport;
    runTrafficAcquisition: typeof runTrafficAcquisition;
    runAudienceReport: typeof runAudienceReport;
    runPagesReport: typeof runPagesReport;
    runEventsReport: typeof runEventsReport;
  };
  searchConsole: { querySearchAnalytics: typeof querySearchAnalytics };
  adsense: { runAdSenseReport: typeof runAdSenseReport };
  adManager: {
    runAdManagerReport: typeof runAdManagerReport;
    adManagerEnabled: typeof adManagerEnabled;
    listAdManagerNetworks: typeof listAdManagerNetworks;
  };
  discovery: {
    listGa4Properties: typeof listGa4Properties;
    listSearchConsoleSites: typeof listSearchConsoleSites;
    listAdSenseAccounts: typeof listAdSenseAccounts;
  };
  tokens: { getValidAccessToken: typeof getValidAccessToken };
  getConnectionAuth: (connectionId: string) => Promise<OAuth2Client>;
  prisma: typeof prisma;
  now: () => Date;
};

async function defaultConnectionAuth(connectionId: string): Promise<OAuth2Client> {
  const accessToken = await getValidAccessToken(connectionId);
  const auth = getOAuthClient();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

export const defaultSyncDeps: SyncDeps = {
  getAuthorizedClientForWebsite,
  getAuthorizedClientForIntegration,
  getPrimaryIntegration,
  getWebsiteOrganizationId: async (websiteId) => {
    const website = await prisma.website.findUnique({ where: { id: websiteId }, select: { organizationId: true } });
    if (!website) throw new Error("NOT_FOUND_OR_FORBIDDEN");
    return website.organizationId;
  },
  cacheSet,
  recordHealth,
  rateLimit,
  ga4: {
    getGa4Client,
    runRealtimeReport,
    runHistoricalReport,
    runTrafficAcquisition,
    runAudienceReport,
    runPagesReport,
    runEventsReport,
  },
  searchConsole: { querySearchAnalytics },
  adsense: { runAdSenseReport },
  adManager: { runAdManagerReport, adManagerEnabled, listAdManagerNetworks },
  discovery: { listGa4Properties, listSearchConsoleSites, listAdSenseAccounts },
  tokens: { getValidAccessToken },
  getConnectionAuth: defaultConnectionAuth,
  prisma,
  now: () => new Date(),
};

/** Same 28-day window the web handler's resolveRange("28d") produces, so the
 *  worker warms exactly the cache keys the dashboards read. */
export function last28Days(now: Date): { startDate: string; endDate: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 27 * 86400000);
  return { startDate: fmt(start), endDate: fmt(now) };
}

type Provider = "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
const REPORTS_BY_KIND: Record<
  string,
  { provider: Provider; source: string; reports: { report: string; ttlSeconds: number }[] }
> = {
  "ga4-realtime": { provider: "GA4", source: "ga4", reports: [{ report: "realtime", ttlSeconds: 30 }] },
  "ga4-historical": {
    provider: "GA4",
    source: "ga4",
    reports: [
      { report: "overview", ttlSeconds: 300 },
      { report: "traffic", ttlSeconds: 300 },
      { report: "audience", ttlSeconds: 300 },
      { report: "pages", ttlSeconds: 300 },
      { report: "events", ttlSeconds: 300 },
    ],
  },
  "search-console": {
    provider: "SEARCH_CONSOLE",
    source: "search-console",
    reports: [{ report: "search-console", ttlSeconds: 3600 }],
  },
  adsense: { provider: "ADSENSE", source: "adsense", reports: [{ report: "adsense", ttlSeconds: 3600 }] },
  "ad-manager": { provider: "AD_MANAGER", source: "ad-manager", reports: [{ report: "ad-manager", ttlSeconds: 3600 }] },
};

const TOKEN_ERRORS = new Set([
  "CONNECTION_REVOKED",
  "TOKEN_REFRESH_FAILED",
  "MISSING_REFRESH_TOKEN",
  "CONNECTION_NOT_FOUND",
]);

async function fetchReport(
  deps: SyncDeps,
  kind: string,
  report: string,
  auth: OAuth2Client,
  propertyId: string,
  range: { startDate: string; endDate: string },
): Promise<unknown> {
  if (kind === "ga4-realtime") return deps.ga4.runRealtimeReport(deps.ga4.getGa4Client(auth), propertyId);
  if (kind === "ga4-historical") {
    const client = deps.ga4.getGa4Client(auth);
    switch (report) {
      case "overview":
        return deps.ga4.runHistoricalReport(client, propertyId, range.startDate, range.endDate);
      case "traffic":
        return deps.ga4.runTrafficAcquisition(client, propertyId, range.startDate, range.endDate);
      case "audience":
        return deps.ga4.runAudienceReport(client, propertyId, range.startDate, range.endDate);
      case "pages":
        return deps.ga4.runPagesReport(client, propertyId, range.startDate, range.endDate);
      case "events":
        return deps.ga4.runEventsReport(client, propertyId, range.startDate, range.endDate);
    }
  }
  if (kind === "search-console")
    return deps.searchConsole.querySearchAnalytics(auth, propertyId, range.startDate, range.endDate, [
      "date",
      "query",
      "page",
    ]);
  if (kind === "adsense") return deps.adsense.runAdSenseReport(auth, propertyId, range.startDate, range.endDate);
  if (kind === "ad-manager") return deps.adManager.runAdManagerReport(auth, propertyId, range.startDate, range.endDate);
  throw new Error(`UNKNOWN_SYNC_KIND:${kind}`);
}

async function syncOneProvider(websiteId: string, kind: string, deps: SyncDeps): Promise<SyncResult> {
  const spec = REPORTS_BY_KIND[kind];
  if (!spec) throw new Error(`UNKNOWN_SYNC_KIND:${kind}`);
  if (spec.provider === "AD_MANAGER" && !deps.adManager.adManagerEnabled()) {
    return { status: "disabled", reports: [], detail: "GOOGLE_AD_MANAGER_ENABLED is false" };
  }
  const integration = await deps.getPrimaryIntegration(websiteId, spec.provider);
  if (!integration)
    return { status: "no_mapping", reports: [], detail: `No ${spec.provider} property mapped to this website.` };
  let client: Awaited<ReturnType<typeof getAuthorizedClientForIntegration>>;
  try {
    // DATA-5: fetch with the connection the mapping was made under.
    client = await deps.getAuthorizedClientForIntegration(websiteId, integration);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "CONNECTION_REQUIRED")
      return {
        status: "not_connected",
        reports: [],
        detail: "No active Google connection for this website or its team.",
      };
    if (TOKEN_ERRORS.has(msg)) {
      await deps.recordHealth({ websiteId, provider: spec.provider, status: "error", lastError: msg });
      return { status: "skipped", reports: [], detail: msg };
    }
    throw e;
  }
  const connectionId = client.connection.connectionId;
  if (connectionId && !(await deps.rateLimit(`google:${connectionId}`, 30, 60_000)).allowed) {
    throw new SyncRateLimitError(connectionId);
  }
  const organizationId = await deps.getWebsiteOrganizationId(websiteId);
  const range = last28Days(deps.now());
  const written: string[] = [];
  try {
    for (const { report, ttlSeconds } of spec.reports) {
      const data = await fetchReport(deps, kind, report, client.auth, integration.externalId, range);
      const cacheKey = buildCacheKey({
        organizationId,
        websiteId,
        propertyId: integration.externalId,
        source: spec.source,
        report,
        range: `${range.startDate}_${range.endDate}`,
      });
      await deps.cacheSet(cacheKey, data, ttlSeconds);
      written.push(report);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await deps.recordHealth({ websiteId, connectionId, provider: spec.provider, status: "error", lastError: msg });
    throw e; // real API error: worker records FAILED, BullMQ retries with backoff
  }
  await deps.recordHealth({ websiteId, connectionId, provider: spec.provider, status: "ok", success: true });
  return { status: "ok", reports: written };
}

/** Run one background sync for a website. See the error contract above. */
export async function syncWebsite(
  websiteId: string,
  kind: SyncKind,
  deps: SyncDeps = defaultSyncDeps,
): Promise<SyncResult> {
  if (kind === "health-check") return healthCheckWebsite(websiteId, deps);
  if (kind === "cache-refresh") {
    // Warm every provider cache the website is mapped for.
    const kinds = ["ga4-historical", "search-console", "adsense", "ad-manager"] as const;
    const reports: string[] = [];
    let last: SyncResult = { status: "skipped", reports: [], detail: "nothing to refresh" };
    for (const k of kinds) {
      const r = await syncOneProvider(websiteId, k, deps);
      reports.push(...r.reports);
      if (r.status === "ok") last = r;
    }
    return { status: reports.length ? "ok" : last.status, reports, detail: last.detail };
  }
  return syncOneProvider(websiteId, kind, deps);
}

/** Verify each mapped provider's connection by obtaining a valid access token
 *  (which refreshes it when needed). Records health per provider. */
export async function healthCheckWebsite(websiteId: string, deps: SyncDeps = defaultSyncDeps): Promise<SyncResult> {
  const providers: Provider[] = ["GA4", "SEARCH_CONSOLE", "ADSENSE", "AD_MANAGER"];
  const checked: string[] = [];
  let anyConnected = false;
  for (const provider of providers) {
    const integration = await deps.getPrimaryIntegration(websiteId, provider);
    if (!integration) continue;
    if (provider === "AD_MANAGER" && !deps.adManager.adManagerEnabled()) continue;
    try {
      const client = await deps.getAuthorizedClientForIntegration(websiteId, integration);
      anyConnected = true;
      await deps.recordHealth({
        websiteId,
        connectionId: client.connection.connectionId,
        provider,
        status: "ok",
        success: true,
      });
      checked.push(provider);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "CONNECTION_REQUIRED")
        return {
          status: "not_connected",
          reports: [],
          detail: "No active Google connection for this website or its team.",
        };
      await deps.recordHealth({ websiteId, provider, status: "error", lastError: msg });
      if (TOKEN_ERRORS.has(msg)) return { status: "skipped", reports: checked, detail: msg };
      throw e;
    }
  }
  if (!checked.length && !anyConnected)
    return { status: "no_mapping", reports: [], detail: "No mapped integrations to check." };
  return { status: "ok", reports: checked };
}

/** Refresh a connection's access token if it is expired or near expiry.
 *  getValidAccessToken performs the refresh (and rotation) when needed. */
export async function refreshConnection(connectionId: string, deps: SyncDeps = defaultSyncDeps): Promise<SyncResult> {
  try {
    await deps.tokens.getValidAccessToken(connectionId);
    return { status: "ok", reports: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (TOKEN_ERRORS.has(msg)) return { status: "skipped", reports: [], detail: msg };
    throw e;
  }
}

/** Discover the Google properties a connection can access and upsert them.
 *  Returns counts per provider. Mapping them to websites stays a user action. */
export async function discoverConnectionProperties(
  connectionId: string,
  deps: SyncDeps = defaultSyncDeps,
): Promise<{ ga4: number; searchConsole: number; adsense: number; adManager: number }> {
  const auth = await deps.getConnectionAuth(connectionId);
  const counts = { ga4: 0, searchConsole: 0, adsense: 0, adManager: 0 };
  // DB-11: upserts run in bounded parallel chunks instead of one sequential
  // round trip per property (a large account can discover hundreds).
  const CHUNK = 10;
  const ga4Props = (await deps.discovery.listGa4Properties(auth)).items.filter((p) => p.propertyId);
  for (let i = 0; i < ga4Props.length; i += CHUNK) {
    await Promise.all(
      ga4Props.slice(i, i + CHUNK).map((p) =>
        deps.prisma.googleProperty.upsert({
          where: { connectionId_propertyId: { connectionId, propertyId: p.propertyId! } },
          update: { displayName: p.displayName ?? null, accountId: p.accountId ?? null },
          create: {
            connectionId,
            propertyId: p.propertyId!,
            displayName: p.displayName ?? null,
            accountId: p.accountId ?? null,
          },
        }),
      ),
    );
    counts.ga4 += Math.min(CHUNK, ga4Props.length - i);
  }
  const scSites = (await deps.discovery.listSearchConsoleSites(auth)).items.filter((s) => s.siteUrl);
  for (let i = 0; i < scSites.length; i += CHUNK) {
    await Promise.all(
      scSites.slice(i, i + CHUNK).map((s) =>
        deps.prisma.searchConsoleProperty.upsert({
          where: { connectionId_siteUrl: { connectionId, siteUrl: s.siteUrl! } },
          update: { permissionLevel: s.permissionLevel ?? null },
          create: { connectionId, siteUrl: s.siteUrl!, permissionLevel: s.permissionLevel ?? null },
        }),
      ),
    );
    counts.searchConsole += Math.min(CHUNK, scSites.length - i);
  }
  const adsAccounts = (await deps.discovery.listAdSenseAccounts(auth)).items.filter((a) => a.accountId);
  for (let i = 0; i < adsAccounts.length; i += CHUNK) {
    await Promise.all(
      adsAccounts.slice(i, i + CHUNK).map((a) =>
        deps.prisma.adSenseAccount.upsert({
          where: { connectionId_accountId: { connectionId, accountId: a.accountId! } },
          update: { displayName: a.displayName ?? null },
          create: { connectionId, accountId: a.accountId!, displayName: a.displayName ?? null },
        }),
      ),
    );
    counts.adsense += Math.min(CHUNK, adsAccounts.length - i);
  }
  if (deps.adManager.adManagerEnabled()) {
    const networks = (await deps.adManager.listAdManagerNetworks(auth)).filter((n) => n.networkCode);
    for (let i = 0; i < networks.length; i += CHUNK) {
      await Promise.all(
        networks.slice(i, i + CHUNK).map((n) =>
          deps.prisma.adManagerNetwork.upsert({
            where: { connectionId_networkCode: { connectionId, networkCode: n.networkCode! } },
            update: { displayName: n.displayName ?? null },
            create: { connectionId, networkCode: n.networkCode!, displayName: n.displayName ?? null },
          }),
        ),
      );
      counts.adManager += Math.min(CHUNK, networks.length - i);
    }
  }
  return counts;
}
