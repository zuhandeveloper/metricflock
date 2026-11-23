import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiKey } from "@/lib/api-key-auth";
import { loadInsights } from "@/lib/insights";

// Public API v1 — SEO/revenue insights (Phase 7.4 derivations).
async function get(req: NextRequest) {
  const auth = await requireApiKey(req);
  if ("error" in auth) return auth.error;
  const insights = await loadInsights(auth.user);
  return NextResponse.json(insights);
}

export const GET = withApiErrors("v1/insights", get);
