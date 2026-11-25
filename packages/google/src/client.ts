import { google } from "googleapis";
import { prisma } from "@metricflock/db";
import { getValidAccessToken } from "./tokens";
import { getOAuthClient, missingScopesForProvider, type GoogleProvider } from "./oauth";
export type ConnectionResolution =
  | { status: "connected"; connectionId: string; level: "WEBSITE" | "TEAM"; googleAccountEmail: string }
  | { status: "not_connected"; connectionId: null; level: null; googleAccountEmail: null };
/** Resolution order: website connection first, then team connection. Never merge credentials. */
export async function resolveConnectionForWebsite(websiteId: string): Promise<ConnectionResolution> {
  const website = await prisma.website.findUnique({ where: { id: websiteId } });
  if (!website) throw new Error("NOT_FOUND_OR_FORBIDDEN");
  // organizationId is part of every lookup: a connection row must never
  // resolve for a website in a different organization. Uses the typed
  // owner FK columns (Stage 2, DB-1); the composite FKs guarantee the
  // owner belongs to the same organization.
  const siteConn = await prisma.googleConnection.findFirst({
    where: {
      organizationId: website.organizationId,
      websiteId,
      status: { in: ["ACTIVE", "EXPIRED", "NEEDS_REAUTH"] },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (siteConn)
    return {
      status: "connected",
      connectionId: siteConn.id,
      level: "WEBSITE",
      googleAccountEmail: siteConn.googleAccountEmail,
    };
  if (website.teamId) {
    const teamConn = await prisma.googleConnection.findFirst({
      where: {
        organizationId: website.organizationId,
        teamId: website.teamId,
        status: { in: ["ACTIVE", "EXPIRED", "NEEDS_REAUTH"] },
      },
      orderBy: { updatedAt: "desc" },
    });
    if (teamConn)
      return {
        status: "connected",
        connectionId: teamConn.id,
        level: "TEAM",
        googleAccountEmail: teamConn.googleAccountEmail,
      };
  }
  return { status: "not_connected", connectionId: null, level: null, googleAccountEmail: null };
}
export async function getAuthorizedClientForWebsite(websiteId: string) {
  const resolved = await resolveConnectionForWebsite(websiteId);
  if (resolved.status !== "connected" || !resolved.connectionId) throw new Error("CONNECTION_REQUIRED");
  const accessToken = await getValidAccessToken(resolved.connectionId);
  const auth = getOAuthClient();
  auth.setCredentials({ access_token: accessToken });
  return { auth, connection: resolved };
}
/** DATA-5: authorize against the connection the mapping was made under.
 *  A property discovered under connection A must be fetched with A's token
 *  even when a website-level connection B also exists — resolving
 *  independently could pair A's property with B's credentials.
 *  A-DB-12: a MAPPED integration with no connection (legacy rows left by
 *  the Stage 2 DB-7 backfill) must NEVER fall back to website→team
 *  resolution — the fallback could fetch the property with an unrelated
 *  connection's credentials (403/empty, or another account's data on a
 *  same-id collision). Throw LEGACY_CONNECTION_MISSING instead; callers
 *  map it to missing_data / no_mapping and prompt a re-map. */
export async function getAuthorizedClientForIntegration(
  websiteId: string,
  integration: { googleConnectionId?: string | null; provider?: GoogleProvider },
) {
  if (!integration.googleConnectionId) throw new Error("LEGACY_CONNECTION_MISSING");
  const website = await prisma.website.findUnique({ where: { id: websiteId }, select: { organizationId: true } });
  if (!website) throw new Error("NOT_FOUND_OR_FORBIDDEN");
  const conn = await prisma.googleConnection.findFirst({
    where: {
      id: integration.googleConnectionId,
      organizationId: website.organizationId,
      status: { in: ["ACTIVE", "EXPIRED", "NEEDS_REAUTH"] },
    },
  });
  if (!conn) throw new Error("CONNECTION_REQUIRED");
  // Scope check before any Google call (F-2.1c): a connection granted
  // without this provider's scope can only produce a 403 — fail fast
  // with a distinct, classifiable error so the UI can prompt reconnect.
  if (integration.provider && missingScopesForProvider(conn.scopes, integration.provider).length > 0) {
    throw new Error("SCOPE_MISSING");
  }
  const accessToken = await getValidAccessToken(conn.id);
  const auth = getOAuthClient();
  auth.setCredentials({ access_token: accessToken });
  const connection: ConnectionResolution = {
    status: "connected",
    connectionId: conn.id,
    level: conn.websiteId === websiteId ? "WEBSITE" : "TEAM",
    googleAccountEmail: conn.googleAccountEmail,
  };
  return { auth, connection };
}
export async function getPrimaryIntegration(
  websiteId: string,
  provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER",
) {
  return prisma.websiteIntegration.findFirst({
    where: { websiteId, provider, mappingStatus: "MAPPED" },
    orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
  });
}

export type PrimaryIntegration = NonNullable<Awaited<ReturnType<typeof getPrimaryIntegration>>>;

/** A-DB-11: batch primary-integration lookup — one query for any
 *  number of websites × providers. Rows arrive primary-first,
 *  newest-first (the same order `getPrimaryIntegration` uses), so the
 *  first row seen for a (website, provider) pair is exactly the row
 *  the single lookup would have returned. */
export async function getPrimaryIntegrations(
  websiteIds: string[],
  providers: GoogleProvider[],
): Promise<Map<string, Map<GoogleProvider, PrimaryIntegration>>> {
  const byWebsite = new Map<string, Map<GoogleProvider, PrimaryIntegration>>();
  if (websiteIds.length === 0 || providers.length === 0) return byWebsite;
  const rows = await prisma.websiteIntegration.findMany({
    where: { websiteId: { in: websiteIds }, provider: { in: providers }, mappingStatus: "MAPPED" },
    orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
  });
  for (const row of rows) {
    let perSite = byWebsite.get(row.websiteId);
    if (!perSite) {
      perSite = new Map();
      byWebsite.set(row.websiteId, perSite);
    }
    const provider = row.provider as GoogleProvider;
    if (!perSite.has(provider)) perSite.set(provider, row);
  }
  return byWebsite;
}
export const _google = google;
