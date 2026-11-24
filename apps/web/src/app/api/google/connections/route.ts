import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth, connectionVisibilityWhere } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { providersMissingScopes } from "@metricflock/google/oauth";
import { adManagerEnabled } from "@metricflock/google/ad-manager";
import { parsePagination } from "@/lib/pagination";
export async function GET(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.view", { req });
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const { limit, offset } = parsePagination(req);
  // SUPER_ADMIN sees all connections in the org; everyone else only
  // connections of teams they administer (audit AUTH-8/API-3).
  const visibility = await connectionVisibilityWhere(user);
  const where = { organizationId: user.organizationId, ...visibility };
  const [conns, total] = await Promise.all([
    prisma.googleConnection.findMany({
      where,
      select: {
        id: true,
        ownerType: true,
        ownerId: true,
        teamId: true,
        websiteId: true,
        googleAccountEmail: true,
        scopes: true,
        status: true,
        lastUsedAt: true,
        lastSuccessfulAuthAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.googleConnection.count({ where }),
  ]);
  // Reauthorization state (F-2.1c/d): providers whose required scopes are
  // missing from the granted set. The UI prompts a reconnect for these.
  const connections = conns.map((c) => {
    const missingProviders = providersMissingScopes(c.scopes, { adManagerEnabled: adManagerEnabled() });
    return { ...c, missingProviders, needsReauth: missingProviders.length > 0 };
  });
  return NextResponse.json({ connections, pagination: { total, limit, offset } });
}
