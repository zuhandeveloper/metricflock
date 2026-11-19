import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import { assertTeamAccess } from "@/lib/tenant";
import { teamCreateSchema } from "@/lib/validation";
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("team.manage");
  if ("error" in auth) return auth.error;
  const { id } = await ctx.params;
  const team = await assertTeamAccess(auth.user, id).catch(() => null);
  if (!team) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const body = teamCreateSchema.partial().safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const updated = await prisma.team.update({ where: { id }, data: body.data });
  return NextResponse.json({ team: updated });
}
