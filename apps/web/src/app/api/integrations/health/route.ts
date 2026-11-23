import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { loadHealthOverview } from "@/lib/health";

// Phase 7.2 — integration health overview (JSON). Same data the
// /health page renders; scoped to websites the caller can access.
async function get(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasPermission(user.role, "analytics.view")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const page = Math.max(1, Number.parseInt(req.nextUrl.searchParams.get("page") ?? "1", 10) || 1);
  const overview = await loadHealthOverview(user, page);
  return NextResponse.json(overview);
}

export const GET = withApiErrors("integrations/health", get);
