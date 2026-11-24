import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { teamCreateSchema, clientIpFromHeaders } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
import { parsePagination } from "@/lib/pagination";
export async function GET(req: NextRequest) {
  const auth = await requireApiAuth("team.view", { req });
  if ("error" in auth) return auth.error;
  const { limit, offset } = parsePagination(req);
  const where = { organizationId: auth.user.organizationId };
  const [teams, total] = await Promise.all([
    prisma.team.findMany({
      where,
      include: { _count: { select: { members: true, websites: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.team.count({ where }),
  ]);
  return NextResponse.json({ teams, pagination: { total, limit, offset } });
}
async function post(req: NextRequest) {
  const auth = await requireApiAuth("team.manage", { req });
  if ("error" in auth) return auth.error;
  const body = teamCreateSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const team = await prisma.team.create({
    data: { organizationId: auth.user.organizationId, name: body.data.name, slug: body.data.slug },
  });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: clientIpFromHeaders(req.headers),
    action: "team.created",
    entityType: "Team",
    entityId: team.id,
    details: { name: team.name },
  });
  return NextResponse.json({ team }, { status: 201 });
}

export const POST = withApiErrors("teams", post);
