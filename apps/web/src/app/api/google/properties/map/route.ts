import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import {
  requireApiAuth,
  assertWebsiteManageAccess,
  assertConnectionVisible,
  assertConnectionScopeForWebsite,
} from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { mapPropertySchema } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
import { invalidateWebsiteCache } from "@metricflock/shared";

// Resolves a discovered property (by provider + externalId) inside the
// caller's organization. A mapping may only point at a property that was
// actually discovered under one of the organization's connections —
// arbitrary externalIds are rejected. When the same property exists under
// several connections, the caller must pass connectionId to disambiguate.
async function resolveDiscoveredProperty(
  organizationId: string,
  provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER",
  externalId: string,
  connectionId?: string,
): Promise<
  | { ok: true; connectionId: string; fk: Record<string, string> }
  | { ok: false; error: "property_not_discovered" | "ambiguous_property" }
> {
  const connFilter = { organizationId, ...(connectionId ? { id: connectionId } : {}) };
  let matches: { id: string; connectionId: string }[] = [];
  let fkField = "";
  if (provider === "GA4") {
    fkField = "googlePropertyId";
    matches = await prisma.googleProperty.findMany({
      where: { propertyId: externalId, connection: connFilter },
      select: { id: true, connectionId: true },
    });
  } else if (provider === "SEARCH_CONSOLE") {
    fkField = "searchConsolePropertyId";
    matches = await prisma.searchConsoleProperty.findMany({
      where: { siteUrl: externalId, connection: connFilter },
      select: { id: true, connectionId: true },
    });
  } else if (provider === "ADSENSE") {
    fkField = "adsenseAccountId";
    matches = await prisma.adSenseAccount.findMany({
      where: { accountId: externalId, connection: connFilter },
      select: { id: true, connectionId: true },
    });
  } else {
    fkField = "adManagerNetworkId";
    matches = await prisma.adManagerNetwork.findMany({
      where: { networkCode: externalId, connection: connFilter },
      select: { id: true, connectionId: true },
    });
  }
  if (matches.length === 0) return { ok: false, error: "property_not_discovered" };
  if (matches.length > 1) return { ok: false, error: "ambiguous_property" };
  return { ok: true, connectionId: matches[0].connectionId, fk: { [fkField]: matches[0].id } };
}

async function post(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.manage");
  if ("error" in auth) return auth.error;
  const body = mapPropertySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const website = await assertWebsiteManageAccess(auth.user, body.data.websiteId).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const resolved = await resolveDiscoveredProperty(
    auth.user.organizationId,
    body.data.provider,
    body.data.externalId,
    body.data.connectionId,
  );
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  // The resolved connection must be one the caller may use (F-1.3):
  // visibility first (foreign-team connections are indistinguishable from
  // missing ones), then the ownership-scope invariant — a team connection
  // may only serve that team's websites, a website connection only that
  // website. This blocks cross-team credential binding inside an org.
  const conn = await prisma.googleConnection.findFirst({
    where: { id: resolved.connectionId, organizationId: auth.user.organizationId },
    select: { teamId: true, websiteId: true, ownerType: true, ownerId: true },
  });
  if (!conn) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const visible = await assertConnectionVisible(auth.user, conn).then(
    () => true,
    () => false,
  );
  if (!visible) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  try {
    assertConnectionScopeForWebsite(conn, website);
  } catch {
    return NextResponse.json({ error: "connection_scope_mismatch" }, { status: 400 });
  }
  const isPrimary = body.data.isPrimary ?? false;
  // One transaction: demote the previous primary (if any) and upsert the
  // mapping with its connection/property FKs. The partial unique index
  // (Stage 2, DB-3) is the database backstop for the single-primary rule.
  const integration = await prisma.$transaction(async (tx) => {
    if (isPrimary) {
      await tx.websiteIntegration.updateMany({
        where: { websiteId: website.id, provider: body.data.provider, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    const integration = await tx.websiteIntegration.upsert({
      where: {
        websiteId_provider_externalId: {
          websiteId: website.id,
          provider: body.data.provider,
          externalId: body.data.externalId,
        },
      },
      update: {
        resourceName: body.data.resourceName,
        isPrimary,
        mappingStatus: "MAPPED",
        googleConnectionId: resolved.connectionId,
        ...resolved.fk,
      },
      create: {
        websiteId: website.id,
        provider: body.data.provider,
        externalId: body.data.externalId,
        resourceName: body.data.resourceName,
        isPrimary,
        mappingStatus: "MAPPED",
        googleConnectionId: resolved.connectionId,
        ...resolved.fk,
      },
    });
    // First successful mapping completes setup: a website stuck at
    // PENDING_SETUP becomes ACTIVE. Only that transition is automatic —
    // manually set states (DISCONNECTED/ARCHIVED) are left alone.
    await tx.website.updateMany({
      where: { id: website.id, status: "PENDING_SETUP" },
      data: { status: "ACTIVE" },
    });
    return integration;
  });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
    action: "google.property.mapped",
    entityType: "Website",
    entityId: website.id,
    details: { provider: body.data.provider, externalId: body.data.externalId, connectionId: resolved.connectionId },
  });
  await invalidateWebsiteCache(auth.user.organizationId, website.id);
  return NextResponse.json({ integration });
}

export const POST = withApiErrors("google/properties/map", post);
