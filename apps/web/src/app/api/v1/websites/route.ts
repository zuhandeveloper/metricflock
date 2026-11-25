import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiKey } from "@/lib/api-key-auth";
import { prisma } from "@metricflock/db";
import { parsePagination } from "@/lib/pagination";

// Public API v1 (Phase 7.5) — read-only, API-key authenticated.
// GET /api/v1/websites — the organization's websites, paginated.
// A-API-09: limit/offset are honoured via parsePagination; the old
// hard-coded take (500) is kept as the default and the max, so
// existing clients see the same list when they pass no params.
// A-API-16: the response carries `pagination: { total, limit, offset }`
// (same shape as GET /api/audit) plus top-level `truncated` (same
// meaning as loadPortfolio's), so a client can tell when the org has
// more websites than the page holds. Additive: `{ websites }` stays.
async function get(req: NextRequest) {
  const auth = await requireApiKey(req, "websites:read");
  if ("error" in auth) return auth.error;
  const { limit, offset } = parsePagination(req, { defaultLimit: 500, maxLimit: 500 });
  const where = { organizationId: auth.organizationId };
  const [websites, total] = await Promise.all([
    prisma.website.findMany({
      where,
      select: { id: true, name: true, domain: true, url: true, status: true, teamId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
      skip: offset,
    }),
    prisma.website.count({ where }),
  ]);
  return NextResponse.json({
    websites,
    pagination: { total, limit, offset },
    truncated: total > offset + websites.length,
  });
}

export const GET = withApiErrors("v1/websites", get);
