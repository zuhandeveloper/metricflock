import type { NextRequest } from "next/server";

/** Bounded offset pagination for list endpoints (API-12). Defaults keep
 *  responses small; the max prevents unbounded reads. Response shape is
 *  additive: existing list keys stay, `pagination` is added alongside. */
export function parsePagination(req: NextRequest): { limit: number; offset: number } {
  const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  const rawOffset = Number(req.nextUrl.searchParams.get("offset") ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  return { limit, offset };
}
