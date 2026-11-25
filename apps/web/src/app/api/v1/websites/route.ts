import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiKey } from "@/lib/api-key-auth";
import { prisma } from "@metricflock/db";
import { parsePagination } from "@/lib/pagination";

// Public API v1 (Phase 7.5) — read-only, API-key authenticated.
// GET /api/v1/websites — the organization's websites (bounded).
// A-API-09: limit/offset are honoured via parsePagination; the old
// hard-coded take (500) is kept as the default and the max, so
// existing clients see the same list when they pass no params.
// The response shape is unchanged ({ websites }) — no new fields.
async function get(req: NextRequest) {
  const auth = await requireApiKey(req, "websites:read");
  if ("error" in auth) return auth.error;
  const { limit, offset } = parsePagination(req, { defaultLimit: 500, maxLimit: 500 });
  const where = { organizationId: auth.organizationId };
  const websites = await prisma.website.findMany({
    where,
    select: { id: true, name: true, domain: true, url: true, status: true, teamId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: limit,
    skip: offset,
  });
  return NextResponse.json({ websites });
}

export const GET = withApiErrors("v1/websites", get);
