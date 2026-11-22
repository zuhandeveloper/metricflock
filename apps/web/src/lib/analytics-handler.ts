import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { assertWebsiteAccess } from "@metricflock/auth";
import { analyticsQuerySchema } from "@metricflock/shared";
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

/** Shared analytics pipeline: auth -> permission -> website access -> connection
 *  resolution -> primary mapping -> cache -> real Google call -> envelope.
 *  Never invents metrics; missing connection/property returns an explicit status. */
export async function handleAnalyticsRequest(
  req: NextRequest,
  opts: {
    permission: Permission;
    provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
    source: string;
    report: string;
    cacheTtlSeconds: number;
    csv?: (data: unknown) => string;
    fetchFn: (ctx: AnalyticsFetchContext) => Promise<unknown>;
  },
): Promise<NextResponse> {
  const auth = await requireApiAuth(opts.permission);
  if ("error" in auth) return auth.error;
  const parsed = analyticsQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success)
    return NextResponse.json({ error: "invalid_input", details: parsed.error.issues }, { status: 400 });
  const { websiteId, range, startDate, endDate, format } = parsed.data;
  const { startDate: sd, endDate: ed } = resolveRange(range, startDate, endDate);
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
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
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
    return NextResponse.json({ error: m || "connection_error" }, { status: 502 });
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
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
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
    return NextResponse.json(
      { error: code, requestId },
      { status: quota ? 429 : 502, headers: { "x-request-id": requestId } },
    );
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
