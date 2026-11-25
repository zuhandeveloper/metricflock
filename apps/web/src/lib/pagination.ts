import type { NextRequest } from "next/server";

// A-API-09: the offset cap. The platform targets 100+ websites, so
// 10,000 rows is 100x any legitimate list window and still blocks the
// deep-offset skip (page 10⁹) that used to be unbounded.
/** Maximum offset (rows) any list endpoint will skip. */
export const MAX_OFFSET = 10_000;

/** Bounded offset pagination for list endpoints (API-12). Defaults keep
 *  responses small; the max prevents unbounded reads. Response shape is
 *  additive: existing list keys stay, `pagination` is added alongside.
 *  `opts` lets a route keep a larger legacy default/max (A-API-09):
 *  v1 websites defaults to 500, api-keys to 100. */
export function parsePagination(
  req: NextRequest,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): { limit: number; offset: number } {
  const maxLimit = opts.maxLimit ?? 200;
  const defaultLimit = Math.min(maxLimit, Math.max(1, Math.floor(opts.defaultLimit ?? 50)));
  const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? defaultLimit);
  const rawOffset = Number(req.nextUrl.searchParams.get("offset") ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(maxLimit, Math.max(1, Math.floor(rawLimit))) : defaultLimit;
  const offset = Number.isFinite(rawOffset) ? Math.min(MAX_OFFSET, Math.max(0, Math.floor(rawOffset))) : 0;
  return { limit, offset };
}
