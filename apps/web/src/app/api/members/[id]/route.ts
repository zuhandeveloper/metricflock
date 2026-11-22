import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { memberRoleSchema } from "@metricflock/shared";

async function patch(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("member.manage");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const body = memberRoleSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });

  const target = await prisma.user.findFirst({
    where: { id, organizationId: auth.user.organizationId },
    select: { id: true, role: true, email: true },
  });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.id === auth.user.id) return NextResponse.json({ error: "cannot_change_own_role" }, { status: 400 });

  // Only a SUPER_ADMIN may grant or revoke SUPER_ADMIN.
  const touchesSuperAdmin = body.data.role === "SUPER_ADMIN" || target.role === "SUPER_ADMIN";
  if (touchesSuperAdmin && auth.user.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Never demote the last SUPER_ADMIN (same guard as the team members
  // route's last-admin rule).
  if (target.role === "SUPER_ADMIN" && body.data.role !== "SUPER_ADMIN") {
    const admins = await prisma.user.count({
      where: { organizationId: auth.user.organizationId, role: "SUPER_ADMIN" },
    });
    if (admins <= 1) return NextResponse.json({ error: "last_super_admin" }, { status: 409 });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { role: body.data.role },
    select: { id: true, email: true, role: true },
  });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "member.role_changed",
    entityType: "User",
    entityId: id,
    details: { email: target.email, from: target.role, to: body.data.role },
  });
  return NextResponse.json({ member: updated });
}

export const PATCH = withApiErrors("members/[id]", patch);
