import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth, assertConnectionVisible } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { getValidAccessToken } from "@metricflock/google/tokens";
import { listGa4Properties, listSearchConsoleSites, listAdSenseAccounts } from "@metricflock/google/discovery";
import { adManagerEnabled, listAdManagerNetworks } from "@metricflock/google/ad-manager";
import { getOAuthClient } from "@metricflock/google/oauth";
import { createLogger, errMeta } from "@metricflock/shared";
import { z } from "zod";
const schema = z.object({ connectionId: z.string().min(1) });

// Coarse, stable classification of provider failures so the UI can tell
// the user what to fix (e.g. enable an API in Google Cloud Console)
// instead of silently reporting "found 0". Raw provider text stays
// server-side in the logs (OAUTH-12).
function classifyProviderError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const data = (
    e as {
      response?: { data?: { error?: { status?: string; message?: string; details?: { reason?: string }[] } } };
    }
  )?.response?.data?.error;
  const reasons = data?.details?.map((d) => d.reason ?? "") ?? [];
  const full = `${msg} ${data?.message ?? ""} ${reasons.join(" ")}`;
  if (/SERVICE_DISABLED|has not been used|is disabled|not been enabled/i.test(full)) return "api_not_enabled";
  if (data?.status === "PERMISSION_DENIED" || /PERMISSION_DENIED|insufficient.*permission/i.test(full)) {
    return "permission_denied";
  }
  if (data?.status === "UNAUTHENTICATED" || /invalid_grant|unauthorized/i.test(full)) return "unauthorized";
  return "provider_error";
}
async function post(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.manage", { req, rateLimit: "strict" });
  if ("error" in auth) return auth.error;
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const conn = await prisma.googleConnection.findFirst({
    where: { id: body.data.connectionId, organizationId: auth.user.organizationId },
  });
  if (!conn) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Discovery spends the connection's Google quota and reveals its
  // properties — same visibility rule as disconnect (audit AUTH-8/API-3).
  const visible = await assertConnectionVisible(auth.user, conn).then(
    () => true,
    () => false,
  );
  if (!visible) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const accessToken = await getValidAccessToken(conn.id);
    const client = getOAuthClient();
    client.setCredentials({ access_token: accessToken });
    const log = createLogger("discover");
    const connId = conn.id;
    async function attempt<T>(
      provider: string,
      fn: () => Promise<{ items: T[]; truncated: boolean; errors?: string[] }>,
    ): Promise<{ items: T[]; truncated: boolean; partialErrors?: string[]; error?: string }> {
      try {
        const res = await fn();
        return { items: res.items, truncated: res.truncated, partialErrors: res.errors };
      } catch (e) {
        log.error("provider discovery failed", { connectionId: connId, provider, ...errMeta(e) });
        return { items: [], truncated: false, error: classifyProviderError(e) };
      }
    }
    const [ga4r, gscr, adsr, admr] = await Promise.all([
      attempt("GA4", () => listGa4Properties(client)),
      attempt("SEARCH_CONSOLE", () => listSearchConsoleSites(client)),
      attempt("ADSENSE", () => listAdSenseAccounts(client)),
      // A-GGL-10: Ad Manager networks were never listed here even when
      // enabled, so the Integrations page could never discover/map one.
      // listAdManagerNetworks returns a plain array (no DiscoveryResult
      // wrapper) and throws AD_MANAGER_DISABLED when disabled, so the
      // attempt is only made when adManagerEnabled() is true.
      // A-GGL-20: it now flags `truncated` when the page cap or a looping
      // token cut the listing short — surface that instead of a hardcoded
      // complete listing.
      adManagerEnabled()
        ? attempt("AD_MANAGER", async () => {
            const networks = await listAdManagerNetworks(client);
            return {
              items: networks.filter((n) => n.networkCode),
              truncated: networks.truncated === true,
            };
          })
        : Promise.resolve(null),
    ]);
    const ga4 = ga4r.items;
    const gsc = gscr.items;
    const adsense = adsr.items;
    // A-GGL-10: null when Ad Manager is disabled — no attempt was made,
    // so the response carries no adManager key at all.
    const adManager = admr?.items ?? [];
    const adManagerAttempted = admr !== null;
    // A-GGL-10: upserts run in bounded parallel chunks (10 at a time,
    // like the sync engine's discoverConnectionProperties) instead of
    // one sequential round trip per property.
    const CHUNK = 10;
    async function upsertChunked<T>(items: T[], upsert: (item: T) => Promise<unknown>): Promise<void> {
      for (let i = 0; i < items.length; i += CHUNK) {
        await Promise.all(items.slice(i, i + CHUNK).map(upsert));
      }
    }
    // A-API-13: batch the upserts. Fresh rows go in one createMany
    // (skipDuplicates — every discovered table has a composite unique
    // on [connectionId, <key>]) instead of one upsert round trip each;
    // only rows that already exist keep the per-row upsert, to refresh
    // their displayName/permissionLevel. A concurrent discovery racing
    // this one is safe: skipDuplicates ignores its inserts, and the
    // upsert path converges on the same values.
    async function splitFresh<T>(
      items: T[],
      keyOf: (item: T) => string,
      listExistingKeys: () => Promise<string[]>,
    ): Promise<{ fresh: T[]; known: T[] }> {
      if (items.length === 0) return { fresh: [], known: [] };
      const existing = new Set(await listExistingKeys());
      return {
        fresh: items.filter((i) => !existing.has(keyOf(i))),
        known: items.filter((i) => existing.has(keyOf(i))),
      };
    }
    // A-GGL-10: delete discovered rows for this connection that no longer
    // appear in the fresh listing — but ONLY when the listing completed:
    // on a provider error the fresh set is empty (pruning would wipe the
    // table) and on a truncated listing it is partial (pruning would
    // delete rows that still exist at Google). And NEVER a row still
    // referenced by a WebsiteIntegration (any status): the A-DB-07
    // CHECKs require the provider's FK on every integration row, so
    // deleting a referenced row would fail the CHECK via the
    // ON DELETE SET NULL cascade — and a mapped row must keep its
    // property. Referenced stale rows are left in place (still
    // mappable / still referenced) and counted in the log.
    type DiscoveredRow = { id: string; key: string };
    async function pruneStale(
      provider: string,
      listExisting: () => Promise<DiscoveredRow[]>,
      listReferencedIds: (staleIds: string[]) => Promise<string[]>,
      deleteIds: (ids: string[]) => Promise<number>,
      freshKeys: Set<string>,
      complete: boolean,
    ): Promise<number> {
      if (!complete) return 0;
      const existing = await listExisting();
      const stale = existing.filter((r) => !freshKeys.has(r.key));
      if (stale.length === 0) return 0;
      const referenced = new Set(await listReferencedIds(stale.map((r) => r.id)));
      const deletable = stale.filter((r) => !referenced.has(r.id)).map((r) => r.id);
      if (deletable.length === 0) {
        if (referenced.size > 0)
          log.info("stale discovered rows kept: still referenced by integrations", {
            connectionId: connId,
            provider,
            kept: referenced.size,
          });
        return 0;
      }
      const deleted = await deleteIds(deletable);
      log.info("pruned stale discovered rows", { connectionId: connId, provider, pruned: deleted });
      return deleted;
    }
    const ga4Split = await splitFresh(
      ga4,
      (p) => p.propertyId,
      () =>
        prisma.googleProperty
          .findMany({ where: { connectionId: conn.id }, select: { propertyId: true } })
          .then((rows) => rows.map((r) => r.propertyId)),
    );
    if (ga4Split.fresh.length > 0)
      await prisma.googleProperty.createMany({
        data: ga4Split.fresh.map((p) => ({
          connectionId: conn.id,
          propertyId: p.propertyId,
          displayName: p.displayName,
          accountId: p.accountId,
        })),
        skipDuplicates: true,
      });
    await upsertChunked(ga4Split.known, (p) =>
      prisma.googleProperty.upsert({
        where: { connectionId_propertyId: { connectionId: conn.id, propertyId: p.propertyId } },
        update: { displayName: p.displayName, accountId: p.accountId },
        create: { connectionId: conn.id, propertyId: p.propertyId, displayName: p.displayName, accountId: p.accountId },
      }),
    );
    const gscSplit = await splitFresh(
      gsc,
      (s) => s.siteUrl,
      () =>
        prisma.searchConsoleProperty
          .findMany({ where: { connectionId: conn.id }, select: { siteUrl: true } })
          .then((rows) => rows.map((r) => r.siteUrl)),
    );
    if (gscSplit.fresh.length > 0)
      await prisma.searchConsoleProperty.createMany({
        data: gscSplit.fresh.map((s) => ({
          connectionId: conn.id,
          siteUrl: s.siteUrl,
          permissionLevel: s.permissionLevel,
        })),
        skipDuplicates: true,
      });
    await upsertChunked(gscSplit.known, (s) =>
      prisma.searchConsoleProperty.upsert({
        where: { connectionId_siteUrl: { connectionId: conn.id, siteUrl: s.siteUrl } },
        update: { permissionLevel: s.permissionLevel },
        create: { connectionId: conn.id, siteUrl: s.siteUrl, permissionLevel: s.permissionLevel },
      }),
    );
    const adsenseSplit = await splitFresh(
      adsense,
      (a) => a.accountId,
      () =>
        prisma.adSenseAccount
          .findMany({ where: { connectionId: conn.id }, select: { accountId: true } })
          .then((rows) => rows.map((r) => r.accountId)),
    );
    if (adsenseSplit.fresh.length > 0)
      await prisma.adSenseAccount.createMany({
        data: adsenseSplit.fresh.map((a) => ({
          connectionId: conn.id,
          accountId: a.accountId,
          displayName: a.displayName,
        })),
        skipDuplicates: true,
      });
    await upsertChunked(adsenseSplit.known, (a) =>
      prisma.adSenseAccount.upsert({
        where: { connectionId_accountId: { connectionId: conn.id, accountId: a.accountId } },
        update: { displayName: a.displayName },
        create: { connectionId: conn.id, accountId: a.accountId, displayName: a.displayName },
      }),
    );
    if (adManagerAttempted) {
      const adManagerSplit = await splitFresh(
        adManager,
        (n) => n.networkCode,
        () =>
          prisma.adManagerNetwork
            .findMany({ where: { connectionId: conn.id }, select: { networkCode: true } })
            .then((rows) => rows.map((r) => r.networkCode)),
      );
      if (adManagerSplit.fresh.length > 0)
        await prisma.adManagerNetwork.createMany({
          data: adManagerSplit.fresh.map((n) => ({
            connectionId: conn.id,
            networkCode: n.networkCode,
            displayName: n.displayName,
          })),
          skipDuplicates: true,
        });
      await upsertChunked(adManagerSplit.known, (n) =>
        prisma.adManagerNetwork.upsert({
          where: { connectionId_networkCode: { connectionId: conn.id, networkCode: n.networkCode } },
          update: { displayName: n.displayName },
          create: { connectionId: conn.id, networkCode: n.networkCode, displayName: n.displayName },
        }),
      );
    }
    const pruned: Record<string, number> = {};
    const prunedGa4 = await pruneStale(
      "GA4",
      () =>
        prisma.googleProperty
          .findMany({ where: { connectionId: conn.id }, select: { id: true, propertyId: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, key: r.propertyId }))),
      (ids) =>
        prisma.websiteIntegration
          .findMany({ where: { googlePropertyId: { in: ids } }, select: { googlePropertyId: true } })
          .then((rows) => rows.map((r) => r.googlePropertyId).filter((x): x is string => x !== null)),
      (ids) => prisma.googleProperty.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
      new Set(ga4.map((p) => p.propertyId)),
      !ga4r.error && !ga4r.truncated,
    );
    if (prunedGa4) pruned.ga4 = prunedGa4;
    const prunedGsc = await pruneStale(
      "SEARCH_CONSOLE",
      () =>
        prisma.searchConsoleProperty
          .findMany({ where: { connectionId: conn.id }, select: { id: true, siteUrl: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, key: r.siteUrl }))),
      (ids) =>
        prisma.websiteIntegration
          .findMany({ where: { searchConsolePropertyId: { in: ids } }, select: { searchConsolePropertyId: true } })
          .then((rows) => rows.map((r) => r.searchConsolePropertyId).filter((x): x is string => x !== null)),
      (ids) => prisma.searchConsoleProperty.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
      new Set(gsc.map((s) => s.siteUrl)),
      !gscr.error && !gscr.truncated,
    );
    if (prunedGsc) pruned.searchConsole = prunedGsc;
    const prunedAdsense = await pruneStale(
      "ADSENSE",
      () =>
        prisma.adSenseAccount
          .findMany({ where: { connectionId: conn.id }, select: { id: true, accountId: true } })
          .then((rows) => rows.map((r) => ({ id: r.id, key: r.accountId }))),
      (ids) =>
        prisma.websiteIntegration
          .findMany({ where: { adsenseAccountId: { in: ids } }, select: { adsenseAccountId: true } })
          .then((rows) => rows.map((r) => r.adsenseAccountId).filter((x): x is string => x !== null)),
      (ids) => prisma.adSenseAccount.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
      new Set(adsense.map((a) => a.accountId)),
      !adsr.error && !adsr.truncated,
    );
    if (prunedAdsense) pruned.adsense = prunedAdsense;
    if (adManagerAttempted) {
      const prunedAdm = await pruneStale(
        "AD_MANAGER",
        () =>
          prisma.adManagerNetwork
            .findMany({ where: { connectionId: conn.id }, select: { id: true, networkCode: true } })
            .then((rows) => rows.map((r) => ({ id: r.id, key: r.networkCode }))),
        (ids) =>
          prisma.websiteIntegration
            .findMany({ where: { adManagerNetworkId: { in: ids } }, select: { adManagerNetworkId: true } })
            .then((rows) => rows.map((r) => r.adManagerNetworkId).filter((x): x is string => x !== null)),
        (ids) => prisma.adManagerNetwork.deleteMany({ where: { id: { in: ids } } }).then((r) => r.count),
        new Set(adManager.map((n) => n.networkCode)),
        !admr.error && !admr.truncated,
      );
      if (prunedAdm) pruned.adManager = prunedAdm;
    }
    const errors: Record<string, string> = {};
    if (ga4r.error) errors.ga4 = ga4r.error;
    if (gscr.error) errors.searchConsole = gscr.error;
    if (adsr.error) errors.adsense = adsr.error;
    if (admr?.error) errors.adManager = admr.error;
    // F-3.3: surface truncation / partial failures instead of presenting
    // a partial list as complete.
    const truncated: Record<string, boolean> = {};
    if (ga4r.truncated) truncated.ga4 = true;
    if (gscr.truncated) truncated.searchConsole = true;
    if (adsr.truncated) truncated.adsense = true;
    if (admr?.truncated) truncated.adManager = true;
    const partial: Record<string, string[]> = {};
    if (ga4r.partialErrors?.length) partial.ga4Accounts = ga4r.partialErrors;
    return NextResponse.json({
      ga4,
      searchConsole: gsc,
      adsense,
      ...(adManagerAttempted ? { adManager } : {}),
      ...(Object.keys(errors).length ? { errors } : {}),
      ...(Object.keys(truncated).length ? { truncated } : {}),
      ...(Object.keys(partial).length ? { partial } : {}),
      ...(Object.keys(pruned).length ? { pruned } : {}),
    });
  } catch (e) {
    // Stable error code to the client; detail stays server-side (OAUTH-12).
    createLogger("discover").error("property discovery failed", { connectionId: conn.id, ...errMeta(e) });
    return NextResponse.json({ error: "discovery_failed" }, { status: 502 });
  }
}

export const POST = withApiErrors("google/properties/discover", post);
