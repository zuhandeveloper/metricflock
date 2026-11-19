import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-helpers";
import { prisma } from "@metricflock/db";
import { listAccessibleWebsiteIds } from "@/lib/tenant";
import { websiteCreateSchema } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
export async function GET(req: NextRequest) {
  const auth = await requireApiAuth("website.view");
  if ("error" in auth) return auth.error;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const ids = await listAccessibleWebsiteIds(auth.user);
  const where: Record<string, unknown> = { organizationId: auth.user.organizationId, ...(ids ? { id: { in: ids } } : {}), ...(status ? { status } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { domain: { contains: q, mode: "insensitive" } }] } : {}) };
  const websites = await prisma.website.findMany({ where: where as never, include: { team: { select: { name: true } }, integrations: { select: { provider: true, mappingStatus: true, isPrimary: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
  return NextResponse.json({ websites });
}
export async function POST(req: NextRequest) {
  const auth = await requireApiAuth("website.manage");
  if ("error" in auth) return auth.error;
  const body = websiteCreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const d = body.data;
  const website = await prisma.website.create({ data: { organizationId: auth.user.organizationId, name: d.name, domain: d.domain, url: d.url, description: d.description, teamId: d.teamId, status: d.status ?? "PENDING_SETUP", purchaseDate: d.purchaseDate ? new Date(d.purchaseDate) : null, saleDate: d.saleDate ? new Date(d.saleDate) : null, purchasePrice: d.purchasePrice, salePrice: d.salePrice, notes: d.notes } });
  await writeAudit({ organizationId: auth.user.organizationId, actorId: auth.user.id, action: "website.created", entityType: "Website", entityId: website.id, details: { domain: website.domain } });
  return NextResponse.json({ website }, { status: 201 });
}
