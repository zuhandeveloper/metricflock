import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { parsePagination } from "@/lib/pagination";

// Programmatic audit access (A-API-12): the `audit.view` permission
// existed but no API route referenced it — audit data was readable only
// via the SUPER_ADMIN-gated server-component page, so API clients and
// SIEM had no access. Mirrors the page exactly: same organization
// filter, newest-first ordering, actor email included. Default limit
// mirrors the page's `take: 100`; `limit`/`offset` are honoured via
// parsePagination. `audit.view` is held by SUPER_ADMIN only today, so
// the rows are org-wide for every current holder; if a future role
// gains `audit.view` it sees the same org-wide log — there is no
// team-scoped audit view, the page has no non-SUPER_ADMIN path to
// mirror. Read-only: no audit write happens here.
async function get(req: NextRequest) {
  const auth = await requireApiAuth("audit.view", { req });
  if ("error" in auth) return auth.error;
  const { limit, offset } = parsePagination(req, { defaultLimit: 100 });
  const where = { organizationId: auth.user.organizationId };
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.auditLog.count({ where }),
  ]);
  return NextResponse.json({ logs, pagination: { total, limit, offset } });
}

export const GET = withApiErrors("audit", get);
