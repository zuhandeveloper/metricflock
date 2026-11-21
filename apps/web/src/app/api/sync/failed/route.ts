import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { parsePagination } from "@/lib/pagination";

// Dead-letter view (Stage 8, OPS-4): terminally failed sync jobs with
// their payloads retained (Stage 5) so an operator can inspect and
// requeue them via POST /api/sync/requeue. SUPER_ADMIN only.
export async function GET(req: NextRequest) {
  const auth = await requireApiAuth();
  if ("error" in auth) return auth.error;
  if (auth.user.role !== "SUPER_ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { limit, offset } = parsePagination(req);
  const [total, jobs] = await Promise.all([
    prisma.analyticsSyncJob.count({ where: { status: "FAILED" } }),
    prisma.analyticsSyncJob.findMany({
      where: { status: "FAILED" },
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
