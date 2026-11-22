import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth, assertConnectionVisible } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { getValidAccessToken } from "@metricflock/google/tokens";
import { listGa4Properties, listSearchConsoleSites, listAdSenseAccounts } from "@metricflock/google/discovery";
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
  const auth = await requireApiAuth("google.connection.manage");
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
    const [ga4r, gscr, adsr] = await Promise.all([
      attempt("GA4", () => listGa4Properties(client)),
      attempt("SEARCH_CONSOLE", () => listSearchConsoleSites(client)),
      attempt("ADSENSE", () => listAdSenseAccounts(client)),
    ]);
    const ga4 = ga4r.items;
    const gsc = gscr.items;
    const adsense = adsr.items;
    for (const p of ga4)
      await prisma.googleProperty.upsert({
        where: { connectionId_propertyId: { connectionId: conn.id, propertyId: p.propertyId } },
        update: { displayName: p.displayName, accountId: p.accountId },
        create: { connectionId: conn.id, propertyId: p.propertyId, displayName: p.displayName, accountId: p.accountId },
      });
    for (const s of gsc)
      await prisma.searchConsoleProperty.upsert({
        where: { connectionId_siteUrl: { connectionId: conn.id, siteUrl: s.siteUrl } },
        update: { permissionLevel: s.permissionLevel },
        create: { connectionId: conn.id, siteUrl: s.siteUrl, permissionLevel: s.permissionLevel },
      });
    for (const a of adsense)
      await prisma.adSenseAccount.upsert({
        where: { connectionId_accountId: { connectionId: conn.id, accountId: a.accountId } },
        update: { displayName: a.displayName },
        create: { connectionId: conn.id, accountId: a.accountId, displayName: a.displayName },
      });
    const errors: Record<string, string> = {};
    if (ga4r.error) errors.ga4 = ga4r.error;
    if (gscr.error) errors.searchConsole = gscr.error;
    if (adsr.error) errors.adsense = adsr.error;
    // F-3.3: surface truncation / partial failures instead of presenting
    // a partial list as complete.
    const truncated: Record<string, boolean> = {};
    if (ga4r.truncated) truncated.ga4 = true;
    if (gscr.truncated) truncated.searchConsole = true;
    if (adsr.truncated) truncated.adsense = true;
    const partial: Record<string, string[]> = {};
    if (ga4r.partialErrors?.length) partial.ga4Accounts = ga4r.partialErrors;
    return NextResponse.json({
      ga4,
      searchConsole: gsc,
      adsense,
      ...(Object.keys(errors).length ? { errors } : {}),
      ...(Object.keys(truncated).length ? { truncated } : {}),
      ...(Object.keys(partial).length ? { partial } : {}),
    });
  } catch (e) {
    // Stable error code to the client; detail stays server-side (OAUTH-12).
    createLogger("discover").error("property discovery failed", { connectionId: conn.id, ...errMeta(e) });
    return NextResponse.json({ error: "discovery_failed" }, { status: 502 });
  }
}

export const POST = withApiErrors("google/properties/discover", post);
