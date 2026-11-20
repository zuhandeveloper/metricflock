import { NextResponse } from "next/server";
import { requireApiAuth, connectionVisibilityWhere } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
export async function GET() {
  const auth = await requireApiAuth("google.connection.view");
  if ("error" in auth) return auth.error;
  const { user } = auth;
  // SUPER_ADMIN sees all connections in the org; everyone else only
  // connections of teams they administer (audit AUTH-8/API-3).
  const visibility = await connectionVisibilityWhere(user);
  const conns = await prisma.googleConnection.findMany({
    where: { organizationId: user.organizationId, ...visibility },
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
  });
  return NextResponse.json({ connections: conns });
}
