import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { assertWebsiteAccess } from "@metricflock/auth";
import { analyticsQuerySchema } from "@metricflock/shared";
import { withApiErrors, apiError, requestIdOf } from "./api-error";
import { analyticsEnvelope, notConnectedEnvelope, missingDataEnvelope, resolveRange } from "./analytics-response";
import {
  buildCacheKey,
  cacheGet,
  cacheSet,
  getRedis,
  createLogger,
  incr,
  sanitizeProviderError,
} from "@metricflock/shared";
import {
  getAuthorizedClientForIntegration,
  getPrimaryIntegration,
  resolveConnectionForWebsite,
} from "@metricflock/google/client";
import { getGa4Client } from "@metricflock/google/ga4";
import { clampSearchConsoleRange } from "@metricflock/google/search-console";
import { lastSuccessfulSync } from "@metricflock/db/health";
import { readSnapshot, writeSnapshot } from "@metricflock/db/snapshots";
import { SYNC_TYPE_BY_REPORT, snapshotTtlSeconds } from "@metricflock/jobs";
import type { Permission } from "@metricflock/auth";
import type { OAuth2Client } from "@metricflock/google/auth-types";

export type AnalyticsFetchContext = {
  auth: OAuth2Client;
  propertyId: string;
  websiteId: string;
  startDate: string;
  endDate: string;
};

/** Coarse, stable classification of provider failures (REST error shapes
 * from googleapis and gRPC shapes from the GA4 Data client) so the UI can
 * tell the user what to fix — e.g. enable an API in Google Cloud Console —
 * instead of a blanket google_api_error. Raw provider text stays
 * server-side in the logs (API-9). */
export function classifyAnalyticsError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const anyE = e as {
    code?: number | string;
    details?: string;
    response?: { data?: { error?: { status?: string; message?: string; details?: { reason?: string }[] } } };
  };
  const data = anyE?.response?.data?.error;
  const reasons = data?.details?.map((d) => d.reason ?? "") ?? [];
  const full = `${msg} ${anyE?.details ?? ""} ${data?.message ?? ""} ${reasons.join(" ")}`;
  if (/SERVICE_DISABLED|has not been used|is disabled|not been enabled/i.test(full)) return "api_not_enabled";
  if (/SCOPE_MISSING/.test(msg)) return "scope_missing";
  if (/TOKEN_REFRESH_LOCK_UNAVAILABLE/.test(msg)) return "temporarily_unavailable";
  // A-GGL-03: timeouts (googleapis race in timeout.ts, Ad Manager poll
  // timeout, or an aborted fetch) are transient, never a client error.
  if (/GOOGLE_API_TIMEOUT|TIMEOUT/i.test(msg) || (e as { name?: string } | null)?.name === "AbortError")
    return "temporarily_unavailable";
  if (/quota|rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(full) || anyE?.code === 8) return "google_quota_exceeded";
  if (
    data?.status === "PERMISSION_DENIED" ||
    /PERMISSION_DENIED|insufficient.*permission/i.test(full) ||
    anyE?.code === 7
  ) {
    return "permission_denied";
  }
  if (data?.status === "UNAUTHENTICATED" || /invalid_grant|unauthorized/i.test(full) || anyE?.code === 16) {
    return "unauthorized";
  }
  if (/INVALID_ARGUMENT/i.test(full) || anyE?.code === 3) return "invalid_request";
  return "google_api_error";
}

/** Options for the shared analytics pipeline. */
export type AnalyticsRequestOpts = {
  permission: Permission;
  provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
  source: string;
  report: string;
  cacheTtlSeconds: number;
  csv?: (data: unknown) => string;
  fetchFn: (ctx: AnalyticsFetchContext) => Promise<unknown>;
};

/** Shared analytics pipeline: auth -> permission -> website access -> connection
 *  resolution -> primary mapping -> cache -> real Google call -> envelope.
 *  Never invents metrics; missing connection/property returns an explicit status.
 *  A-API-02: the pipeline is wrapped in `withApiErrors` so a throw in
 *  connection resolution (or anywhere else) returns the contract error
 *  instead of a framework 500. */
export async function handleAnalyticsRequest(req: NextRequest, opts: AnalyticsRequestOpts): Promise<NextResponse> {
  return withApiErrors<[NextRequest], NextResponse>(`analytics:${opts.report}`, () =>
    handleAnalyticsRequestInner(req, opts),
  )(req);
}

/** Inner pipeline (unwrapped so the wrapper above owns the error contract). */
async function handleAnalyticsRequestInner(req: NextRequest, opts: AnalyticsRequestOpts): Promise<NextResponse> {
  const requestId = requestIdOf(req);
  // A-SEC-07: the nine analytics routes are the cheapest Google-quota
  // burn vector — strict per-user-per-route limit (20/min) before any
  // provider call is attempted.
  const auth = await requireApiAuth(opts.permission, { req, rateLimit: "strict" });
  if ("error" in auth) return auth.error;
  const parsed = analyticsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) return apiError("invalid_input", 400, parsed.error.issues, requestId);
  const { websiteId, range, startDate, endDate, format } = parsed.data;
  let { startDate: sd, endDate: ed } = resolveRange(range, startDate, endDate);
  // A-GGL-07: Search Console data lags 2-3 days — clamp the range
  // before the cache key, the fetch and the envelope, so a requested
  // 28d never silently covers ~25 days of real data and the envelope
  // reports the effective range. GA4/AdSense/Ad Manager are untouched.
  if (opts.provider === "SEARCH_CONSOLE") {
    ({ startDate: sd, endDate: ed } = clampSearchConsoleRange(sd, ed));
  }
  if (!websiteId) {
    // Org-wide aggregate (Phase 7.1, DATA-6): totals are computed from
    // per-website DB snapshots — no live Google fan-out, no invented
    // numbers. Websites without a snapshot for the range are listed
    // unavailable with the reason.
    const { loadPortfolio } = await import("./portfolio");
    const portfolio = await loadPortfolio(auth.user, {
      provider: opts.provider,
      source: opts.source,
      report: opts.report,
      startDate: sd,
      endDate: ed,
    });
    return analyticsEnvelope({
      data: {
        totals: portfolio.totals,
        totalsNote: portfolio.totalsNote,
        websiteCount: portfolio.websiteCount,
        truncated: portfolio.truncated,
        websites: portfolio.websites.map((w) => ({
          websiteId: w.websiteId,
          name: w.name,
          domain: w.domain,
          snapshotUpdatedAt: w.snapshotUpdatedAt,
          stale: w.stale,
        })),
      },
      includedWebsites: portfolio.websites.map((w) => w.websiteId),
      unavailableWebsites: portfolio.unavailableWebsites,
      dataSource: opts.source,
      freshness: portfolio.websites.length ? "snapshot" : "unavailable",
      range: { startDate: sd, endDate: ed },
    });
  }
  const website = await assertWebsiteAccess(auth.user, websiteId).catch(() => null);
  if (!website) return apiError("not_found_or_forbidden", 404, undefined, requestId);
  // Connection state first: an unconnected website must report not_connected
  // (the actionable state), not missing_data for the absent property mapping.
  const resolved = await resolveConnectionForWebsite(websiteId);
  if (resolved.status !== "connected") return notConnectedEnvelope(websiteId);
  const integration = await getPrimaryIntegration(websiteId, opts.provider);
  if (!integration) return missingDataEnvelope(websiteId, `No ${opts.provider} property mapped to this website.`);
  let client: Awaited<ReturnType<typeof getAuthorizedClientForIntegration>>;
  try {
    // DATA-5: fetch with the connection the mapping was made under.
    client = await getAuthorizedClientForIntegration(websiteId, integration);
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m === "CONNECTION_REQUIRED") return notConnectedEnvelope(websiteId);
    // A-DB-12: a MAPPED integration with no connection is unmappable —
    // never fetch it under another connection's credentials. The
    // mapping is still there (externalId preserved); the user re-maps it.
    if (m === "LEGACY_CONNECTION_MISSING")
      return missingDataEnvelope(
        websiteId,
        "This property mapping has no Google connection. Re-map the property to fetch data.",
      );
    // A-GGL-15: route through the same classification as the fetch catch
    // so one state has one contract — a scope-deficient connection yields
    // `scope_missing` here just as it does from the fetch path, and the UI
    // can prompt re-connect. Statuses match the fetch catch exactly:
    // 429 only for quota, 502 otherwise.
    const code = classifyAnalyticsError(e);
    const quota = code === "google_quota_exceeded";
    createLogger("analytics").error("authorized client failed", { requestId, websiteId, error: m });
    incr(quota ? "provider.quota_error" : "provider.error");
    return apiError(code, quota ? 429 : 502, undefined, requestId);
  }
  const cacheKey = buildCacheKey({
    organizationId: auth.user.organizationId,
    websiteId,
    propertyId: integration.externalId,
    source: opts.source,
    report: opts.report,
    range: `${sd}_${ed}`,
  });
  const cached = await cacheGet<unknown>(cacheKey);
  const syncType = SYNC_TYPE_BY_REPORT[opts.report];
  if (cached && !cached.stale) {
    return analyticsEnvelope({
      data: cached.value,
      websiteId,
      includedWebsites: [websiteId],
      unavailableWebsites: [],
      lastSyncedAt: syncType ? await lastSuccessfulSync(websiteId, syncType) : null,
      dataSource: opts.source,
      freshness: "cached",
      range: { startDate: sd, endDate: ed },
    });
  }
  // Hybrid read order (Phase 5, F-5.4): Redis → fresh DB snapshot →
  // live Google. A snapshot written by the worker's scheduled sync (or
  // an earlier live fetch) serves the request without spending Google
  // quota; it is labeled "snapshot", never passed off as live.
  const snapshot = await readSnapshot(cacheKey).catch(() => null);
  if (snapshot && snapshot.expiresAt.getTime() > Date.now()) {
    incr("snapshot.hit");
    // Re-warm Redis so the next request is a cache hit.
    await cacheSet(cacheKey, snapshot.payload, opts.cacheTtlSeconds);
    return analyticsEnvelope({
      data: snapshot.payload,
      websiteId,
      includedWebsites: [websiteId],
      unavailableWebsites: [],
      lastSyncedAt: syncType ? await lastSuccessfulSync(websiteId, syncType) : null,
      dataSource: opts.source,
      freshness: "snapshot",
      range: { startDate: sd, endDate: ed },
    });
  }
  if (snapshot) incr("snapshot.stale");
  // OPS-6 single-flight: one request per cache key calls Google; concurrent
  // cold requests wait briefly for the winner's cache write instead of
  // stampeding the provider (and burning quota) in parallel.
  const redis = getRedis();
  const lockKey = `lock:fetch:${cacheKey}`;
  let lockToken: string | null = null;
  if (redis) {
    lockToken = `${process.pid}:${Date.now()}:${Math.random()}`;
    const acquired = await redis.set(lockKey, lockToken, "PX", 30_000, "NX").catch(() => null);
    if (acquired !== "OK") {
      lockToken = null;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const again = await cacheGet<unknown>(cacheKey);
        if (again && !again.stale) {
          return analyticsEnvelope({
            data: again.value,
            websiteId,
            includedWebsites: [websiteId],
            unavailableWebsites: [],
            lastSyncedAt: syncType ? await lastSuccessfulSync(websiteId, syncType) : null,
            dataSource: opts.source,
            freshness: "cached",
            range: { startDate: sd, endDate: ed },
          });
        }
      }
      // Winner is slow or died: fall through and fetch ourselves.
    }
  }
  try {
    const data = await opts.fetchFn({
      auth: client.auth,
      propertyId: integration.externalId,
      websiteId,
      startDate: sd,
      endDate: ed,
    });
    await cacheSet(cacheKey, data, opts.cacheTtlSeconds);
    // Hybrid (F-5.4): persist the live result as a DB snapshot too, so
    // later views (and Redis restarts) don't need another Google call.
    await writeSnapshot(cacheKey, websiteId, data, snapshotTtlSeconds(opts.report, opts.cacheTtlSeconds)).catch(
      () => undefined,
    );
    if (format === "csv" && opts.csv) {
      return new NextResponse(opts.csv(data), {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${opts.report}-${websiteId}.csv"`,
        },
      });
    }
    return analyticsEnvelope({
      data,
      websiteId,
      includedWebsites: [websiteId],
      unavailableWebsites: [],
      lastSyncedAt: syncType ? await lastSuccessfulSync(websiteId, syncType) : null,
      dataSource: opts.source,
      // DATA-10: freshly fetched data is "live" — never mislabeled SWR.
      freshness: "live",
      range: { startDate: sd, endDate: ed },
    });
  } catch (e) {
    const code = classifyAnalyticsError(e);
    const quota = code === "google_quota_exceeded";
    // API-9: provider error text stays server-side; clients get a stable
    // code + requestId they can quote in a bug report.
    createLogger("analytics").error("provider fetch failed", {
      requestId,
      report: opts.report,
      provider: opts.provider,
      quota,
      error: sanitizeProviderError(e, 1000),
    });
    incr(quota ? "provider.quota_error" : "provider.error");
    // OPS-6 true stale-while-revalidate: on provider error, serve the stale
    // value we already hold (labeled stale) instead of failing the request.
    // Hybrid (F-5.4): a stale DB snapshot is the next fallback.
    if (cached) {
      return analyticsEnvelope({
        data: cached.value,
        websiteId,
        includedWebsites: [websiteId],
        unavailableWebsites: [],
        lastSyncedAt: syncType ? await lastSuccessfulSync(websiteId, syncType) : null,
        dataSource: opts.source,
        freshness: "stale",
        range: { startDate: sd, endDate: ed },
      });
    }
    if (snapshot) {
      incr("snapshot.stale_served");
      return analyticsEnvelope({
        data: snapshot.payload,
        websiteId,
        includedWebsites: [websiteId],
        unavailableWebsites: [],
        lastSyncedAt: syncType ? await lastSuccessfulSync(websiteId, syncType) : null,
        dataSource: opts.source,
        freshness: "stale",
        range: { startDate: sd, endDate: ed },
      });
    }
    return apiError(code, quota ? 429 : 502, undefined, requestId);
  } finally {
    if (redis && lockToken) {
      await redis
        .eval(
          `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
          1,
          lockKey,
          lockToken,
        )
        .catch(() => {});
    }
  }
}
export { getGa4Client };
