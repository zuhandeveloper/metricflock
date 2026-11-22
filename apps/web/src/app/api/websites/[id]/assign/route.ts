import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { assertWebsiteManageAccess } from "@metricflock/auth";
import { writeAudit } from "@metricflock/db/audit";
import { invalidateWebsiteCache } from "@metricflock/shared";
import { z } from "zod";
const schema = z.object({ userId: z.string().min(1), action: z.enum(["assign", "remove"]).default("assign") });
async function post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("website.assign");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  // Manage-level access: an assigned viewer must not grant/revoke access.
  const website = await assertWebsiteManageAccess(auth.user, id).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const target = await prisma.user.findFirst({
    where: { id: body.data.userId, organizationId: auth.user.organizationId },
  });
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  if (body.data.action === "assign") {
    await prisma.websiteAssignment.upsert({
      where: { websiteId_userId: { websiteId: id, userId: target.id } },
      update: {},
      create: { websiteId: id, userId: target.id, organizationId: auth.user.organizationId },
    });
  } else {
    await prisma.websiteAssignment.deleteMany({ where: { websiteId: id, userId: target.id } });
  }
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: `website.${body.data.action}`,
    entityType: "Website",
    entityId: id,
    details: { userId: target.id },
  });
  await invalidateWebsiteCache(auth.user.organizationId, id);
  return NextResponse.json({ status: "ok" });
}

export const POST = withApiErrors("websites/[id]/assign", post);
