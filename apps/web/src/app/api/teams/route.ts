import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { teamCreateSchema } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
export async function GET() {
  const auth = await requireApiAuth("team.view");
  if ("error" in auth) return auth.error;
  const teams = await prisma.team.findMany({
    where: { organizationId: auth.user.organizationId },
    include: { _count: { select: { members: true, websites: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ teams });
}
export async function POST(req: NextRequest) {
  const auth = await requireApiAuth("team.manage");
  if ("error" in auth) return auth.error;
  const body = teamCreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const team = await prisma.team.create({
    data: { organizationId: auth.user.organizationId, name: body.data.name, slug: body.data.slug },
  });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    action: "team.created",
    entityType: "Team",
    entityId: team.id,
    details: { name: team.name },
  });
  return NextResponse.json({ team }, { status: 201 });
}
