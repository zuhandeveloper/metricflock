import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { getValidAccessToken } from "@metricflock/google/tokens";
import { listGa4Properties, listSearchConsoleSites, listAdSenseAccounts } from "@metricflock/google/discovery";
import { getOAuthClient } from "@metricflock/google/oauth";
import { z } from "zod";
const schema = z.object({ connectionId: z.string().min(1) });
export async function POST(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.manage");
  if ("error" in auth) return auth.error;
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const conn = await prisma.googleConnection.findFirst({
    where: { id: body.data.connectionId, organizationId: auth.user.organizationId },
  });
  if (!conn) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const accessToken = await getValidAccessToken(conn.id);
    const client = getOAuthClient();
    client.setCredentials({ access_token: accessToken });
    const [ga4, gsc, adsense] = await Promise.all([
      listGa4Properties(client).catch(() => []),
      listSearchConsoleSites(client).catch(() => []),
      listAdSenseAccounts(client).catch(() => []),
    ]);
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
    return NextResponse.json({ ga4, searchConsole: gsc, adsense });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "discovery_failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
