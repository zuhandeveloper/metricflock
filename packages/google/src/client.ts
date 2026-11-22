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
 *  independently could pair A's property with B's credentials. Falls back
 *  to website→team resolution only when the mapping carries no connection
 *  (legacy rows predating the Stage 2 backfill). */
export async function getAuthorizedClientForIntegration(
  websiteId: string,
  integration: { googleConnectionId?: string | null; provider?: GoogleProvider },
) {
  if (integration.googleConnectionId) {
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
  return getAuthorizedClientForWebsite(websiteId);
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
export const _google = google;
