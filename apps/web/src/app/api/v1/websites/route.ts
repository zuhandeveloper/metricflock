import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiKey } from "@/lib/api-key-auth";
import { prisma } from "@metricflock/db";

// Public API v1 (Phase 7.5) — read-only, API-key authenticated.
// GET /api/v1/websites — the organization's websites (bounded).
async function get(req: NextRequest) {
  const auth = await requireApiKey(req, "websites:read");
  if ("error" in auth) return auth.error;
  const websites = await prisma.website.findMany({
    where: { organizationId: auth.organizationId },
    select: { id: true, name: true, domain: true, url: true, status: true, teamId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  return NextResponse.json({ websites });
}

export const GET = withApiErrors("v1/websites", get);
