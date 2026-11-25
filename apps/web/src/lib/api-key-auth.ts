import { NextRequest, NextResponse } from "next/server";
import { apiError, requestIdOf } from "./api-error";
import { prisma } from "@metricflock/db";
import { hashToken, isApiKeyFormat, rateLimit, type ApiKeyScope } from "@metricflock/shared";

// Public API authentication (Phase 7.5). Keys are organization-level
// and read-only: `Authorization: Bearer mf_...`. Only the SHA-256
// hash is stored; lookup is by hash. Each key is rate-limited to 120
// requests/minute. Keys act with organization-wide read scope (they
// are created by SUPER_ADMINs); the synthetic user below mirrors
// that scope for the shared loaders.
// A-SEC-09: keys may carry an optional `expiresAt` (null = never
// expires) and per-key `scopes` (empty = legacy full v1 access).
// `requireApiKey` enforces both: an expired key is rejected with
// 401, and a key whose scopes omit the route's required scope is
// rejected with 403 `insufficient_scope`.
export type ApiKeyAuth = {
  organizationId: string;
  keyId: string;
  scopes: ApiKeyScope[];
  expiresAt: Date | null;
  user: { id: string; organizationId: string; role: string };
};

const API_RATE_LIMIT = 120;

export async function requireApiKey(
  req: NextRequest,
  requiredScope?: ApiKeyScope,
): Promise<ApiKeyAuth | { error: NextResponse }> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !isApiKeyFormat(token))
    return {
      // A-API-11: the human-readable reason lives in `details`, not as a
      // top-level `message` — the error envelope is `{ error, requestId }`
      // plus `details` only.
      error: apiError("unauthorized", 401, { message: "Missing or malformed API key." }, requestIdOf(req)),
    };

  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hashToken(token) },
    select: { id: true, organizationId: true, createdById: true, revokedAt: true, expiresAt: true, scopes: true },
  });
  if (!key || key.revokedAt)
    return {
      error: apiError("unauthorized", 401, { message: "Invalid or revoked API key." }, requestIdOf(req)),
    };
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now())
    return {
      error: apiError("unauthorized", 401, { message: "API key has expired." }, requestIdOf(req)),
    };
  const scopes = (key.scopes ?? []) as ApiKeyScope[];
  if (requiredScope && scopes.length > 0 && !scopes.includes(requiredScope))
    return {
      error: apiError(
        "insufficient_scope",
        403,
        { message: `API key lacks the ${requiredScope} scope.` },
        requestIdOf(req),
      ),
    };

  const limit = await rateLimit(`apikey:${key.id}`, API_RATE_LIMIT, 60_000);
  if (!limit.allowed)
    return {
      error: apiError(
        "rate_limited",
        429,
        { message: `API key limit is ${API_RATE_LIMIT} requests/minute.` },
        requestIdOf(req),
      ),
    };

  // Fire-and-forget usage stamp; never block the request on it.
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return {
    organizationId: key.organizationId,
    keyId: key.id,
    scopes,
    expiresAt: key.expiresAt ?? null,
    user: { id: key.createdById, organizationId: key.organizationId, role: "SUPER_ADMIN" },
  };
}
