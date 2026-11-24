import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiKey } from "@/lib/api-key-auth";
import { loadHealthOverview } from "@/lib/health";

// Public API v1 — integration health summary + first page of rows.
async function get(req: NextRequest) {
  const auth = await requireApiKey(req, "health:read");
  if ("error" in auth) return auth.error;
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? 1) || 1);
  const overview = await loadHealthOverview(auth.user, page);
  return NextResponse.json(overview);
}

export const GET = withApiErrors("v1/health", get);
