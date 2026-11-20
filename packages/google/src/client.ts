import { google } from "googleapis";
import { prisma } from "@metricflock/db";
import { getValidAccessToken } from "./tokens";
import { getOAuthClient } from "./oauth";
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
