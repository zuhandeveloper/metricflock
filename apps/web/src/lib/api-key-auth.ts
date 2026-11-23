import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@metricflock/db";
import { hashToken, isApiKeyFormat, rateLimit } from "@metricflock/shared";

// Public API authentication (Phase 7.5). Keys are organization-level
// and read-only: `Authorization: Bearer mf_...`. Only the SHA-256
// hash is stored; lookup is by hash. Each key is rate-limited to 120
// requests/minute. Keys act with organization-wide read scope (they
// are created by SUPER_ADMINs); the synthetic user below mirrors
// that scope for the shared loaders.
export type ApiKeyAuth = {
  organizationId: string;
  keyId: string;
  user: { id: string; organizationId: string; role: string };
};

const API_RATE_LIMIT = 120;

export async function requireApiKey(req: NextRequest): Promise<ApiKeyAuth | { error: NextResponse }> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !isApiKeyFormat(token))
    return {
      error: NextResponse.json({ error: "unauthorized", message: "Missing or malformed API key." }, { status: 401 }),
    };

  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hashToken(token) },
    select: { id: true, organizationId: true, createdById: true, revokedAt: true },
  });
  if (!key || key.revokedAt)
    return {
      error: NextResponse.json({ error: "unauthorized", message: "Invalid or revoked API key." }, { status: 401 }),
    };

  const limit = await rateLimit(`apikey:${key.id}`, API_RATE_LIMIT, 60_000);
  if (!limit.allowed)
    return {
      error: NextResponse.json(
        { error: "rate_limited", message: `API key limit is ${API_RATE_LIMIT} requests/minute.` },
        { status: 429 },
      ),
    };

  // Fire-and-forget usage stamp; never block the request on it.
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return {
    organizationId: key.organizationId,
    keyId: key.id,
    user: { id: key.createdById, organizationId: key.organizationId, role: "SUPER_ADMIN" },
  };
}
