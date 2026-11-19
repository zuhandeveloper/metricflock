import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
export async function GET() {
  const auth = await requireApiAuth("google.connection.view");
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const where = user.role === "SUPER_ADMIN" ? { organizationId: user.organizationId } : { organizationId: user.organizationId };
  const conns = await prisma.googleConnection.findMany({ where, select: { id: true, ownerType: true, ownerId: true, googleAccountEmail: true, scopes: true, status: true, lastUsedAt: true, lastSuccessfulAuthAt: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ connections: conns });
}
