import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-helpers";
import { prisma } from "@metricflock/db";
import { assertWebsiteAccess } from "@/lib/tenant";
import { mapPropertySchema } from "@/lib/validation";
import { writeAudit } from "@/lib/audit";
import { invalidateWebsiteCache } from "@/lib/cache";
export async function POST(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.manage");
  if ("error" in auth) return auth.error;
  const body = mapPropertySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input", details: body.error.issues }, { status: 400 });
  const website = await assertWebsiteAccess(auth.user, body.data.websiteId).catch(() => null);
  if (!website) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  const integration = await prisma.websiteIntegration.upsert({
    where: { websiteId_provider_externalId: { websiteId: website.id, provider: body.data.provider, externalId: body.data.externalId } },
    update: { resourceName: body.data.resourceName, isPrimary: body.data.isPrimary ?? false, mappingStatus: "MAPPED" },
    create: { websiteId: website.id, provider: body.data.provider, externalId: body.data.externalId, resourceName: body.data.resourceName, isPrimary: body.data.isPrimary ?? false, mappingStatus: "MAPPED" },
  });
  await writeAudit({ organizationId: auth.user.organizationId, actorId: auth.user.id, action: "google.property.mapped", entityType: "Website", entityId: website.id, details: { provider: body.data.provider, externalId: body.data.externalId } });
  await invalidateWebsiteCache(auth.user.organizationId, website.id);
  return NextResponse.json({ integration });
}
