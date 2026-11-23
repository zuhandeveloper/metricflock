import { NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { loadInsights } from "@/lib/insights";

// SEO/revenue intelligence (Phase 7.4). Read-only derivations from
// synced snapshots; analytics.view + accessible-website scoping.
async function get() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasPermission(user.role, "analytics.view")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const insights = await loadInsights(user);
  return NextResponse.json(insights);
}

export const GET = withApiErrors("insights", get);
