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
//   FAILED and BullMQ retries with exponential backoff. Exception (A-WRK-07):
//   a provider that warmed at least one report returns "partial" with the
//   failed reports in `detail` instead of throwing — the job SUCCEEDS and
//   the retry does not refetch the reports that already warmed. Only when
//   every report failed, or the failure is rate-limit/quota shaped, does
//   the sync throw.
// - Per-connection rate limiting throws SyncRateLimitError — the worker turns
//   it into BullMQ's RateLimitError so the job is delayed, not failed.
import { prisma } from "@metricflock/db";
import { recordHealth } from "@metricflock/db/health";
import { snapshotTtlSeconds } from "@metricflock/jobs";
import { buildCacheKey, cacheSet, createLogger, errMeta, rateLimit, sanitizeProviderError } from "@metricflock/shared";
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
import { querySearchAnalytics, clampSearchConsoleRange } from "./search-console";
import { runAdSenseReport } from "./adsense";
import { runAdManagerReport, adManagerEnabled, listAdManagerNetworks } from "./ad-manager";
import { listGa4Properties, listSearchConsoleSites, listAdSenseAccounts } from "./discovery";
import { getValidAccessToken } from "./tokens";
import { getOAuthClient } from "./oauth";
import type { OAuth2Client } from "./auth-types";

export type SyncKind =
  "ga4-realtime" | "ga4-historical" | "search-console" | "adsense" | "ad-manager" | "health-check" | "cache-refresh";
export type SyncStatus = "ok" | "skipped" | "not_connected" | "no_mapping" | "disabled" | "partial";
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
  /** Hybrid snapshots (Phase 5, F-5.4): persist each synced report to
   * the DB snapshot layer. Optional so existing test fakes keep
   * working; production defaults wire the real implementation. */
  writeSnapshot?: (cacheKey: string, websiteId: string, payload: unknown, ttlSeconds: number) => Promise<void>;
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
  writeSnapshot: async (cacheKey, websiteId, payload, ttlSeconds) => {
    const { writeSnapshot } = await import("@metricflock/db/snapshots");
    await writeSnapshot(cacheKey, websiteId, payload, ttlSeconds);
  },
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

/** Permanent auth failures that only a user re-connect can fix (A-GGL-04):
 *  SCOPE_MISSING means the connection was granted without this provider's
 *  scope — no amount of retrying can grant a scope, so the sync engine
 *  must not burn BullMQ attempts on it. Recorded as health
 *  "needs_reauth" so the UI can prompt re-connect. */
const NEEDS_REAUTH_ERRORS = new Set(["SCOPE_MISSING"]);

/** Health status for a permanent auth error, or null when the error is
 *  retryable (real API errors throw and BullMQ retries them). */
function authErrorHealthStatus(msg: string): "error" | "needs_reauth" | null {
  if (NEEDS_REAUTH_ERRORS.has(msg)) return "needs_reauth";
  if (TOKEN_ERRORS.has(msg)) return "error";
  return null;
}

/** Quota-shaped Google errors (parity with the web layer's
 *  classifyAnalyticsError, plus the HTTP 429 status googleapis carries
 *  as `code`/`status`): the API is telling us to back off. A report that
 *  fails this way aborts the provider sync and throws (retry/delay)
 *  instead of burning more quota on the remaining reports. */
function isQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const anyE = e as {
    code?: number | string;
    status?: number | string;
    details?: string;
    response?: { status?: number | string; data?: { error?: { message?: string; details?: { reason?: string }[] } } };
  };
  const data = anyE?.response?.data?.error;
  const reasons = data?.details?.map((d) => d.reason ?? "") ?? [];
  const full = `${msg} ${anyE?.details ?? ""} ${data?.message ?? ""} ${reasons.join(" ")}`;
  if (/quota|rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(full)) return true;
  const codes = [anyE?.code, anyE?.status, anyE?.response?.status].map((c) => String(c));
  return codes.includes("8") || codes.includes("429");
}

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
    // A-DB-12: a MAPPED integration with no connection is unmappable —
    // never fetch it under another connection's credentials. Terminal:
    // retrying cannot fix it, and the mapping stays for a re-map.
    if (msg === "LEGACY_CONNECTION_MISSING")
      return {
        status: "no_mapping",
        reports: [],
        detail: "Mapping has no Google connection; re-map the property.",
      };
    const authStatus = authErrorHealthStatus(msg);
    if (authStatus) {
      await deps.recordHealth({
        websiteId,
        provider: spec.provider,
        status: authStatus,
        lastError: sanitizeProviderError(e),
      });
      return { status: "skipped", reports: [], detail: msg };
    }
    throw e;
  }
  const connectionId = client.connection.connectionId;
  // A-GGL-19: fail closed — on a Redis error the limiter returns
  // allowed:false, which throws SyncRateLimitError below and the worker
  // delays the job (the handled path). Without it, a Redis outage would
  // degrade this per-connection quota guard to a per-process one that
  // multiplies per worker instance against a per-project Google quota.
  if (connectionId && !(await deps.rateLimit(`google:${connectionId}`, 30, 60_000, { failClosed: true })).allowed) {
    throw new SyncRateLimitError(connectionId);
  }
  const organizationId = await deps.getWebsiteOrganizationId(websiteId);
  // A-GGL-07: the worker warms exactly the cache keys the dashboards
  // read, so the SC sync clamps the same way the web handler does —
  // endDate 3 days ago, cache key and fetch both on the effective range.
  // Every other provider keeps the unclamped 28-day window.
  const rawRange = last28Days(deps.now());
  const range =
    kind === "search-console" ? clampSearchConsoleRange(rawRange.startDate, rawRange.endDate, deps.now()) : rawRange;
  // A-WRK-07: per-report isolation — one report's failure must not abort
  // the rest. A failure on report 3 used to leave reports 1–2 cached but
  // fail the whole job, and the BullMQ retry refetched all 5, wasting
  // Google quota. A failed report records error health and the loop
  // continues; when at least one report warmed, the result is "partial"
  // with the failed reports listed. Only when every report failed, or
  // the failure is rate-limit/quota shaped, does the sync throw so
  // BullMQ retries — a quota error aborts the loop immediately, because
  // the API is telling us to back off, not to burn more quota on the
  // remaining reports.
  const written: string[] = [];
  const failures: { report: string; reason: string; error: Error }[] = [];
  for (const { report, ttlSeconds } of spec.reports) {
    try {
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
      // Hybrid (F-5.4): also persist a DB snapshot so dashboards can
      // serve this sync without a live Google call. Snapshot failures
      // must not fail the sync — Redis is already warmed.
      await deps
        .writeSnapshot?.(cacheKey, websiteId, data, snapshotTtlSeconds(report, ttlSeconds))
        .catch(() => undefined);
      written.push(report);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err instanceof SyncRateLimitError || isQuotaError(err)) {
        await deps
          .recordHealth({
            websiteId,
            connectionId,
            provider: spec.provider,
            status: "error",
            lastError: sanitizeProviderError(err),
          })
          .catch(() => undefined);
        throw err;
      }
      const reason = sanitizeProviderError(err);
      // Best-effort: a failing health write must not abort the
      // remaining reports — that is the isolation this loop provides.
      await deps
        .recordHealth({ websiteId, connectionId, provider: spec.provider, status: "error", lastError: reason })
        .catch(() => undefined);
      failures.push({ report, reason, error: err });
    }
  }
  if (failures.length && written.length === 0) {
    // Every report failed: keep the old contract — the worker records
    // FAILED and BullMQ retries with backoff.
    throw failures[0].error;
  }
  if (failures.length) {
    return {
      status: "partial",
      reports: written,
      detail: failures.map((f) => `${f.report}: ${f.reason}`).join("; "),
    };
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
    // A-GGL-12: warm every provider cache the website is mapped for,
    // with per-provider isolation — one provider's outage (quota, 5xx)
    // must not starve the other providers' caches. A genuine throw is
    // caught, the provider's health is recorded, and the loop continues
    // with the rest. Terminal results (disabled / no_mapping /
    // not_connected / skipped) are expected states, not failures, so
    // they never turn the aggregate into "partial" on their own — a
    // site without Ad Manager refreshes "ok", as before.
    const kinds = ["ga4-historical", "search-console", "adsense", "ad-manager"] as const;
    const reports: string[] = [];
    const failures: { provider: Provider; reason: string }[] = [];
    const thrown: Error[] = [];
    for (const k of kinds) {
      const provider = REPORTS_BY_KIND[k].provider;
      try {
        const r = await syncOneProvider(websiteId, k, deps);
        reports.push(...r.reports);
        // A-WRK-07: a provider that warmed some reports but not all
        // returns "partial" — surface its failed reports in the
        // aggregate detail instead of silently reporting "ok".
        if (r.status === "partial" && r.detail) failures.push({ provider, reason: r.detail });
      } catch (e) {
        const reason = sanitizeProviderError(e);
        // Rate limiting is transient throttling, not a provider health
        // failure: the worker delays the job instead of failing it, and
        // recording "error" health here would flip the dashboard red
        // and fire a transition alert for a condition that clears in
        // 60s. Every other throw is a real failure — record it. For
        // fetch errors this duplicates the identical record
        // syncOneProvider already wrote (recordHealth upserts by
        // website+provider and no consumer reads the row's
        // connectionId, so the duplicate is a no-op); for throws from
        // client resolution / org lookup it is the only record. The
        // write itself is best-effort: a failing health write must not
        // abort the remaining providers — that is the isolation this
        // branch exists to provide.
        if (!(e instanceof SyncRateLimitError)) {
          await deps.recordHealth({ websiteId, provider, status: "error", lastError: reason }).catch(() => undefined);
        }
        failures.push({ provider, reason });
        thrown.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
    if (reports.length) {
      if (!failures.length) return { status: "ok", reports };
      return {
        status: "partial",
        reports,
        detail: failures.map((f) => `${f.provider}: ${f.reason}`).join("; "),
      };
    }
    // Nothing was warmed at all: keep the old contract and let the job
    // FAIL so BullMQ retries with backoff (and a rate-limited run is
    // delayed, not failed, by the worker) — a "partial" success here
    // would also block a manual retry for the hour, since a SUCCEEDED
    // row answers `already_completed` (A-API-06).
    if (thrown.length) throw thrown[0];
    return { status: "skipped", reports: [], detail: "nothing to refresh" };
  }
  return syncOneProvider(websiteId, kind, deps);
}

/** Verify each mapped provider's connection by obtaining a valid access token
 *  (which refreshes it when needed). Records health per provider. A provider
 *  whose connection is missing is recorded as `not_connected` and the check
 *  continues with the remaining providers (A-GGL-11) — it must not abort
 *  the whole check, or healthy providers would lose their `lastSuccessAt`
 *  updates and the site would look entirely unconnected. The same holds
 *  for every other per-provider failure (A-WRK-08): a token error or a
 *  provider API error is recorded as error health and the loop continues,
 *  so a revoked GA4 connection cannot mask a simultaneously-failing
 *  AdSense connection. The aggregate status is `ok` when every checked
 *  provider is healthy, `partial` when some checked ok and others failed
 *  (the failures are listed in `detail`), `not_connected` when none is
 *  connected, `skipped` when nothing checked ok and every failure is a
 *  permanent auth failure, and `no_mapping` when nothing is mapped at
 *  all. Only when no provider could be checked at all because of a
 *  generic (non-auth) error does the check throw, so BullMQ retries it. */
export async function healthCheckWebsite(websiteId: string, deps: SyncDeps = defaultSyncDeps): Promise<SyncResult> {
  const providers: Provider[] = ["GA4", "SEARCH_CONSOLE", "ADSENSE", "AD_MANAGER"];
  const checked: string[] = [];
  const notConnected: string[] = [];
  // A-WRK-08: per-provider failures are collected, never an early
  // return — every mapped provider gets a fresh health row (with its
  // recovered/alert_error transitions) on every run.
  const failed: string[] = [];
  let firstGenericError: unknown;
  for (const provider of providers) {
    const integration = await deps.getPrimaryIntegration(websiteId, provider);
    if (!integration) continue;
    if (provider === "AD_MANAGER" && !deps.adManager.adManagerEnabled()) continue;
    try {
      const client = await deps.getAuthorizedClientForIntegration(websiteId, integration);
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
      // A-GGL-11: a missing connection is a per-provider state, not a
      // reason to abort the check — record it (the health dashboard
      // derives "error" from any non-"ok" status and alerts once per
      // transition) and keep checking the remaining providers.
      if (msg === "CONNECTION_REQUIRED") {
        await deps.recordHealth({
          websiteId,
          provider,
          status: "not_connected",
          lastError: "No active Google connection for this website or its team.",
        });
        notConnected.push(provider);
        continue;
      }
      // A-DB-12: a legacy mapping with no connection is unmappable, not
      // a failed check — record it as an error (the dashboard surfaces
      // the re-map prompt) and keep checking the other providers instead
      // of throwing and retrying the whole health-check job. It stays
      // untracked in the aggregate (A-DB-12's `no_mapping` contract):
      // a legacy mapping is "unmappable", not a provider failure.
      if (msg === "LEGACY_CONNECTION_MISSING") {
        await deps.recordHealth({
          websiteId,
          provider,
          status: "error",
          lastError: "Mapping has no Google connection; re-map the property.",
        });
        continue;
      }
      const authStatus = authErrorHealthStatus(msg);
      const sanitized = sanitizeProviderError(e);
      await deps.recordHealth({
        websiteId,
        provider,
        status: authStatus ?? "error",
        lastError: sanitized,
      });
      failed.push(`${provider}: ${sanitized}`);
      // A token error is permanent (only a re-connect fixes it), so it
      // is recorded and the check continues. A generic error may be a
      // transient infrastructure failure, so it is remembered: if no
      // provider could be checked at all, the job throws and BullMQ
      // retries instead of reporting a success.
      if (!authStatus && firstGenericError === undefined) firstGenericError = e;
    }
  }
  if (!checked.length && !notConnected.length && !failed.length)
    return { status: "no_mapping", reports: [], detail: "No mapped integrations to check." };
  if (checked.length) {
    if (!notConnected.length && !failed.length) return { status: "ok", reports: checked };
    const failures = [...notConnected.map((p) => `${p}: not_connected`), ...failed];
    return { status: "partial", reports: checked, detail: failures.join("; ") };
  }
  // Nothing checked ok: a generic failure anywhere means the check
  // itself could not run (throw so BullMQ retries); purely auth
  // failures are permanent, so the job succeeds as skipped with the
  // failures in the detail instead of burning retries.
  if (firstGenericError !== undefined) throw firstGenericError;
  if (failed.length) {
    const failures = [...notConnected.map((p) => `${p}: not_connected`), ...failed];
    return { status: "skipped", reports: [], detail: failures.join("; ") };
  }
  return {
    status: "not_connected",
    reports: [],
    detail: "No active Google connection for this website or its team.",
  };
}

/** Refresh a connection's access token if it is expired or near expiry.
 *  getValidAccessToken performs the refresh (and rotation) when needed. */
export async function refreshConnection(connectionId: string, deps: SyncDeps = defaultSyncDeps): Promise<SyncResult> {
  try {
    await deps.tokens.getValidAccessToken(connectionId);
    return { status: "ok", reports: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (authErrorHealthStatus(msg)) return { status: "skipped", reports: [], detail: msg };
    throw e;
  }
}

/** Counts returned by `discoverConnectionProperties`. `errors` and `pruned`
 *  are present only when non-empty, so existing exact-equality assertions
 *  on the four counts keep passing. */
export type DiscoveryCounts = {
  ga4: number;
  searchConsole: number;
  adsense: number;
  adManager: number;
  /** Per-provider listing/upsert failures, keyed like the web route's
   *  `errors` map (A-GGL-10). A provider that failed still lets the other
   *  providers report their stored counts. */
  errors?: Record<string, string>;
  /** Stale discovered rows pruned per provider (A-GGL-10 guards). */
  pruned?: Record<string, number>;
};

/** Discover the Google properties a connection can access and upsert them.
 *  Returns counts per provider. Mapping them to websites stays a user action.
 *  A-GGL-13: each provider is isolated — a listing/upsert failure in one
 *  provider is collected in `errors` and never aborts the others — and only
 *  successful upserts are counted. Stale discovered rows are pruned per
 *  provider, with the same guards as the web route (A-GGL-10).
 *  A-WRK-15: when NO provider could be listed at all, throw the first error
 *  instead of returning all-zero counts — a total failure (revoked token,
 *  network/Google outage) is likely transient, so the worker records FAILED
 *  and BullMQ retries with backoff; a partial failure still returns counts
 *  + `errors` (a disabled API cannot be fixed by retrying). */
export async function discoverConnectionProperties(
  connectionId: string,
  deps: SyncDeps = defaultSyncDeps,
): Promise<DiscoveryCounts> {
  const auth = await deps.getConnectionAuth(connectionId);
  const log = createLogger("discovery");
  const counts = { ga4: 0, searchConsole: 0, adsense: 0, adManager: 0 };
  const errors: Record<string, string> = {};
  const pruned: Record<string, number> = {};
  // A-WRK-15: true once any provider's listing call returns (even with zero
  // items or partial upsert failures). If it stays false, every attempted
  // provider failed to list — throw the first error so the job retries.
  let listed = false;
  let firstError: unknown;
  // DB-11: upserts run in bounded parallel chunks instead of one sequential
  // round trip per property (a large account can discover hundreds).
  const CHUNK = 10;

  // Upsert one provider's items in bounded chunks. allSettled (not
  // Promise.all) so one bad row neither aborts the chunk nor inflates the
  // count: only successful upserts are counted (A-GGL-13).
  async function upsertChunked<T>(
    items: T[],
    upsert: (item: T) => Promise<unknown>,
  ): Promise<{ succeeded: number; firstError?: unknown }> {
    let succeeded = 0;
    let firstError: unknown;
    for (let i = 0; i < items.length; i += CHUNK) {
      const results = await Promise.allSettled(items.slice(i, i + CHUNK).map(upsert));
      for (const r of results) {
        if (r.status === "fulfilled") succeeded++;
        else if (firstError === undefined) firstError = r.reason;
      }
    }
    return { succeeded, firstError };
  }

  // Delete discovered rows for this connection that no longer appear in the
  // fresh listing — same guards as the web route (A-GGL-10): only when the
  // listing completed, and never a row still referenced by a
  // WebsiteIntegration (any status). Best-effort: a prune failure is logged
  // and never fails a discovery whose counts are already stored (and
  // minimal test doubles that only stub `upsert` keep working).
  type DiscoveredRow = { id: string; key: string };
  async function pruneStale(
    provider: string,
    listExisting: () => Promise<DiscoveredRow[]>,
    listReferencedIds: (staleIds: string[]) => Promise<string[]>,
    deleteIds: (ids: string[]) => Promise<number>,
    freshKeys: Set<string>,
  ): Promise<number> {
    try {
      const existing = await listExisting();
      const stale = existing.filter((r) => !freshKeys.has(r.key));
      if (stale.length === 0) return 0;
      const referenced = new Set(await listReferencedIds(stale.map((r) => r.id)));
      const deletable = stale.filter((r) => !referenced.has(r.id)).map((r) => r.id);
      if (deletable.length === 0) {
        if (referenced.size > 0)
          log.info("stale discovered rows kept: still referenced by integrations", {
            connectionId,
            provider,
            kept: referenced.size,
          });
        return 0;
      }
      const deleted = await deleteIds(deletable);
      log.info("pruned stale discovered rows", { connectionId, provider, pruned: deleted });
      return deleted;
    } catch (e) {
      log.warn("stale discovered rows prune failed", { connectionId, provider, ...errMeta(e) });
      return 0;
    }
  }

  // GA4 — per-account isolation already lives in listGa4Properties (failed
  // accounts land in `errors`). A partial listing must not prune: the failed
  // accounts' properties are absent from the fresh set, so pruning would
  // delete rows that still exist at Google. (The web route does not apply
  // this guard — its partialErrors do not block pruning — the worker path
  // is stricter here.)
  try {
    const res = await deps.discovery.listGa4Properties(auth);
    listed = true;
    const items = res.items.filter((p) => p.propertyId);
    const { succeeded, firstError } = await upsertChunked(items, (p) =>
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
    );
    counts.ga4 = succeeded;
    if (firstError !== undefined) errors.ga4 = sanitizeProviderError(firstError);
    if (res.errors.length > 0) log.warn("GA4 discovery partially failed", { connectionId, accounts: res.errors });
    if (!res.truncated && res.errors.length === 0) {
      const deleted = await pruneStale(
        "GA4",
        () =>
          deps.prisma.googleProperty
            .findMany({ where: { connectionId }, select: { id: true, propertyId: true } })
            .then((rows) => rows.map((r) => ({ id: r.id, key: r.propertyId }))),
        (ids) =>
          deps.prisma.websiteIntegration
            .findMany({ where: { googlePropertyId: { in: ids } }, select: { googlePropertyId: true } })
            .then((rows) => rows.map((r) => r.googlePropertyId).filter((x): x is string => x !== null)),
        (ids) => deps.prisma.googleProperty.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
        new Set(items.map((p) => p.propertyId!)),
      );
      if (deleted) pruned.ga4 = deleted;
    }
  } catch (e) {
    if (firstError === undefined) firstError = e;
    errors.ga4 = sanitizeProviderError(e);
    log.error("provider discovery failed", { connectionId, provider: "GA4", ...errMeta(e) });
  }

  try {
    const res = await deps.discovery.listSearchConsoleSites(auth);
    listed = true;
    const items = res.items.filter((s) => s.siteUrl);
    const { succeeded, firstError } = await upsertChunked(items, (s) =>
      deps.prisma.searchConsoleProperty.upsert({
        where: { connectionId_siteUrl: { connectionId, siteUrl: s.siteUrl! } },
        update: { permissionLevel: s.permissionLevel ?? null },
        create: { connectionId, siteUrl: s.siteUrl!, permissionLevel: s.permissionLevel ?? null },
      }),
    );
    counts.searchConsole = succeeded;
    if (firstError !== undefined) errors.searchConsole = sanitizeProviderError(firstError);
    if (!res.truncated) {
      const deleted = await pruneStale(
        "SEARCH_CONSOLE",
        () =>
          deps.prisma.searchConsoleProperty
            .findMany({ where: { connectionId }, select: { id: true, siteUrl: true } })
            .then((rows) => rows.map((r) => ({ id: r.id, key: r.siteUrl }))),
        (ids) =>
          deps.prisma.websiteIntegration
            .findMany({ where: { searchConsolePropertyId: { in: ids } }, select: { searchConsolePropertyId: true } })
            .then((rows) => rows.map((r) => r.searchConsolePropertyId).filter((x): x is string => x !== null)),
        (ids) => deps.prisma.searchConsoleProperty.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
        new Set(items.map((s) => s.siteUrl!)),
      );
      if (deleted) pruned.searchConsole = deleted;
    }
  } catch (e) {
    if (firstError === undefined) firstError = e;
    errors.searchConsole = sanitizeProviderError(e);
    log.error("provider discovery failed", { connectionId, provider: "SEARCH_CONSOLE", ...errMeta(e) });
  }

  try {
    const res = await deps.discovery.listAdSenseAccounts(auth);
    listed = true;
    const items = res.items.filter((a) => a.accountId);
    const { succeeded, firstError } = await upsertChunked(items, (a) =>
      deps.prisma.adSenseAccount.upsert({
        where: { connectionId_accountId: { connectionId, accountId: a.accountId! } },
        update: { displayName: a.displayName ?? null },
        create: { connectionId, accountId: a.accountId!, displayName: a.displayName ?? null },
      }),
    );
    counts.adsense = succeeded;
    if (firstError !== undefined) errors.adsense = sanitizeProviderError(firstError);
    if (!res.truncated) {
      const deleted = await pruneStale(
        "ADSENSE",
        () =>
          deps.prisma.adSenseAccount
            .findMany({ where: { connectionId }, select: { id: true, accountId: true } })
            .then((rows) => rows.map((r) => ({ id: r.id, key: r.accountId }))),
        (ids) =>
          deps.prisma.websiteIntegration
            .findMany({ where: { adsenseAccountId: { in: ids } }, select: { adsenseAccountId: true } })
            .then((rows) => rows.map((r) => r.adsenseAccountId).filter((x): x is string => x !== null)),
        (ids) => deps.prisma.adSenseAccount.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
        new Set(items.map((a) => a.accountId!)),
      );
      if (deleted) pruned.adsense = deleted;
    }
  } catch (e) {
    if (firstError === undefined) firstError = e;
    errors.adsense = sanitizeProviderError(e);
    log.error("provider discovery failed", { connectionId, provider: "ADSENSE", ...errMeta(e) });
  }

  // Ad Manager (only when enabled — a disabled setup is not an error).
  // listAdManagerNetworks returns a plain array (no DiscoveryResult), so a
  // completed call is a complete listing.
  if (deps.adManager.adManagerEnabled()) {
    try {
      const networks = (await deps.adManager.listAdManagerNetworks(auth)).filter((n) => n.networkCode);
      listed = true;
      const { succeeded, firstError } = await upsertChunked(networks, (n) =>
        deps.prisma.adManagerNetwork.upsert({
          where: { connectionId_networkCode: { connectionId, networkCode: n.networkCode! } },
          update: { displayName: n.displayName ?? null },
          create: { connectionId, networkCode: n.networkCode!, displayName: n.displayName ?? null },
        }),
      );
      counts.adManager = succeeded;
      if (firstError !== undefined) errors.adManager = sanitizeProviderError(firstError);
      const deleted = await pruneStale(
        "AD_MANAGER",
        () =>
          deps.prisma.adManagerNetwork
            .findMany({ where: { connectionId }, select: { id: true, networkCode: true } })
            .then((rows) => rows.map((r) => ({ id: r.id, key: r.networkCode }))),
        (ids) =>
          deps.prisma.websiteIntegration
            .findMany({ where: { adManagerNetworkId: { in: ids } }, select: { adManagerNetworkId: true } })
            .then((rows) => rows.map((r) => r.adManagerNetworkId).filter((x): x is string => x !== null)),
        (ids) => deps.prisma.adManagerNetwork.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
        new Set(networks.map((n) => n.networkCode!)),
      );
      if (deleted) pruned.adManager = deleted;
    } catch (e) {
      if (firstError === undefined) firstError = e;
      errors.adManager = sanitizeProviderError(e);
      log.error("provider discovery failed", { connectionId, provider: "AD_MANAGER", ...errMeta(e) });
    }
  }

  if (!listed) {
    // A-WRK-15: no provider could be listed — keep the all-failed contract
    // (like syncOneProvider): the worker records FAILED and BullMQ retries
    // with backoff instead of reporting a silent all-zero "ok".
    throw firstError ?? new Error("discovery failed: no provider could be listed");
  }

  return {
    ...counts,
    ...(Object.keys(errors).length ? { errors } : {}),
    ...(Object.keys(pruned).length ? { pruned } : {}),
  };
}
