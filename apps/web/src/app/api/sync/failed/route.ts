import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { parsePagination } from "@/lib/pagination";
import { syncJobOrgWhere } from "@/lib/sync-scope";

// Dead-letter view (Stage 8, OPS-4): terminally failed sync jobs with
// their payloads retained (Stage 5) so an operator can inspect and
// requeue them via POST /api/sync/requeue. SUPER_ADMIN only.
// A-SEC-01: scoped to the caller's organization via website —
// websiteId = null rows are visible to no tenant.
async function get(req: NextRequest) {
  const auth = await requireApiAuth(undefined, { req });
  if ("error" in auth) return auth.error;
  if (auth.user.role !== "SUPER_ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { limit, offset } = parsePagination(req);
  const [total, jobs] = await Promise.all([
    prisma.analyticsSyncJob.count({ where: { status: "FAILED", ...syncJobOrgWhere(auth.user.organizationId) } }),
    prisma.analyticsSyncJob.findMany({
      where: { status: "FAILED", ...syncJobOrgWhere(auth.user.organizationId) },
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        websiteId: true,
        type: true,
        status: true,
        attempts: true,
        lastError: true,
        payload: true,
        updatedAt: true,
      },
    }),
  ]);
  return NextResponse.json({ jobs, pagination: { total, limit, offset } });
}

export const GET = withApiErrors("sync/failed", get);
