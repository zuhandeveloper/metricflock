import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, apiError } from "@/lib/api-error";
import { requireApiAuth, requireFreshSession } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { generateApiKey, apiKeyDisplayPrefix, hashToken, parseApiKeyExpiry } from "@metricflock/shared";

// Rotate an API key (A-SEC-09). Revokes the old key and mints a
// replacement with the same name and scopes, so a key approaching
// expiry (or a suspected leak) can be replaced without changing
// which endpoints the consumer may call. The new secret is returned
// exactly once; the old secret stops working immediately.
async function post(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiAuth("organization.manage", { req });
  if ("error" in auth) return auth.error;
  // A-SEC-02: minting a persistent org-wide credential requires a
  // fresh session — a stale session must re-authenticate first.
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
  const { id } = await ctx.params;
  const old = await prisma.apiKey.findFirst({
    where: { id, organizationId: auth.user.organizationId },
    select: { id: true, name: true, scopes: true, expiresAt: true, revokedAt: true },
  });
  if (!old || old.revokedAt) return apiError("api_key_not_found", 404);
  if (old.expiresAt && old.expiresAt.getTime() <= Date.now())
    return apiError("key_expired", 400, { message: "An expired key cannot be rotated; create a new key instead." });
  const body = (await req.json().catch(() => ({}))) as { expiresAt?: unknown };
  const expiry = parseApiKeyExpiry(body.expiresAt);
  if (expiry.error) return apiError("invalid_expires_at", 400, { message: expiry.error });
  // No explicit expiry → the replacement inherits the old key's
  // expiry, so rotation never silently extends a key's lifetime.
  const expiresAt = body.expiresAt === undefined ? old.expiresAt : expiry.expiresAt;

  const secret = generateApiKey();
  const key = await prisma.$transaction(async (tx) => {
    await tx.apiKey.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
    return tx.apiKey.create({
      data: {
        organizationId: auth.user.organizationId,
        name: old.name,
        keyHash: hashToken(secret),
        prefix: apiKeyDisplayPrefix(secret),
        createdById: auth.user.id,
        expiresAt,
        scopes: old.scopes,
      },
      select: { id: true, name: true, prefix: true, expiresAt: true, scopes: true, createdAt: true },
    });
  });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    action: "api_key.rotated",
    entityType: "ApiKey",
    entityId: key.id,
    details: { name: old.name, rotatedFrom: old.id },
  }).catch(() => undefined); // A-API-04: audit failure must not turn a rotated key into a 500.
  // Shown once — the client must store it now; it cannot be recovered.
  return NextResponse.json({ key, secret }, { status: 201 });
}

export const POST = withApiErrors("api-keys/[id]/rotate", post);
