import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { assertWebsiteAccess } from "@metricflock/auth";
import { websiteCreateSchema } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("website.view");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const website = await assertWebsiteAccess(auth.user, id).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const full = await prisma.website.findUnique({ where: { id }, include: { team: true, assignments: { include: { user: { select: { id: true, email: true, name: true } } } }, integrations: true, transfers: { orderBy: { createdAt: "desc" }, take: 10 } } });
  return NextResponse.json({ website: full });
}
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("website.manage");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const website = await assertWebsiteAccess(auth.user, id).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const body = websiteCreateSchema.partial().safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const d = body.data;
  const updated = await prisma.website.update({ where: { id }, data: { name: d.name, domain: d.domain, url: d.url, description: d.description, teamId: d.teamId, status: d.status, purchaseDate: d.purchaseDate ? new Date(d.purchaseDate) : undefined, saleDate: d.saleDate ? new Date(d.saleDate) : undefined, purchasePrice: d.purchasePrice, salePrice: d.salePrice, notes: d.notes } });
  await writeAudit({ organizationId: auth.user.organizationId, actorId: auth.user.id, action: "website.updated", entityType: "Website", entityId: id, details: { domain: updated.domain } });
  return NextResponse.json({ website: updated });
}
