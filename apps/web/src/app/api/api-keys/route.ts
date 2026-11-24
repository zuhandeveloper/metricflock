import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, apiError } from "@/lib/api-error";
import { requireApiAuth, requireFreshSession } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import {
  generateApiKey,
  apiKeyDisplayPrefix,
  hashToken,
  parseApiKeyExpiry,
  parseApiKeyScopes,
} from "@metricflock/shared";

// API key management (Phase 7.5). SUPER_ADMIN only
// (organization.manage). The plaintext secret is returned exactly
// once, in the POST response; only its SHA-256 hash is stored.
// A-SEC-09: keys may be minted with an optional `expiresAt` (ISO
// date, in the future, at most 1 year out) and optional `scopes`
// (subset of the v1 read scopes). Omitting both keeps the legacy
// behaviour: a key that never expires with full v1 access.
async function get(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage", { req });
  if ("error" in auth) return auth.error;
  const keys = await prisma.apiKey.findMany({
    where: { organizationId: auth.user.organizationId },
    select: {
      id: true,
      name: true,
      prefix: true,
      lastUsedAt: true,
      revokedAt: true,
      expiresAt: true,
      scopes: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ keys });
}

async function post(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage", { req });
  if ("error" in auth) return auth.error;
  // A-SEC-02: minting a persistent org-wide credential requires a
  // fresh session — a stale session must re-authenticate first.
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; expiresAt?: unknown; scopes?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return apiError("invalid_name", 400, { message: "name is required (max 80 chars)." });
  const expiry = parseApiKeyExpiry(body.expiresAt);
  if (expiry.error) return apiError("invalid_expires_at", 400, { message: expiry.error });
  const scopes = parseApiKeyScopes(body.scopes);
  if (scopes === null)
    return apiError("invalid_scopes", 400, { message: "scopes must be an array of known v1 read scopes." });

  const secret = generateApiKey();
  const key = await prisma.apiKey.create({
    data: {
      organizationId: auth.user.organizationId,
      name,
      keyHash: hashToken(secret),
      prefix: apiKeyDisplayPrefix(secret),
      createdById: auth.user.id,
      expiresAt: expiry.expiresAt,
      scopes,
    },
    select: { id: true, name: true, prefix: true, expiresAt: true, scopes: true, createdAt: true },
  });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    action: "api_key.created",
    entityType: "ApiKey",
    entityId: key.id,
    details: { name, scopes, expiresAt: expiry.expiresAt?.toISOString() ?? null },
  }).catch(() => undefined); // A-API-04: audit failure must not turn a created key into a 500.
  // Shown once — the client must store it now; it cannot be recovered.
  return NextResponse.json({ key, secret }, { status: 201 });
}

export const GET = withApiErrors("api-keys", get);
export const POST = withApiErrors("api-keys", post);
