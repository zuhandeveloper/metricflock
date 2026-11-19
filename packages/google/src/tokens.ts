import { google } from "googleapis";
import { prisma } from "@metricflock/db";
import { decryptToken, encryptToken } from "@metricflock/shared";
import { getOAuthClient } from "./oauth";
// Refresh an access token; handles rotation (new refresh token replaces old) and
// missing refresh token (existing authorizations may not return one) + revoked grants.
export async function getValidAccessToken(connectionId: string): Promise<string> {
  const conn = await prisma.googleConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new Error("CONNECTION_NOT_FOUND");
  if (conn.status === "REVOKED" || conn.status === "DISCONNECTED") throw new Error("CONNECTION_REVOKED");
  if (conn.encryptedAccessToken && conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() > Date.now() + 60_000) {
    return decryptToken(conn.encryptedAccessToken);
  }
  if (!conn.encryptedRefreshToken) throw new Error("MISSING_REFRESH_TOKEN");
  const refreshToken = decryptToken(conn.encryptedRefreshToken);
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const { credentials } = await client.refreshAccessToken();
    if (!credentials.access_token) throw new Error("TOKEN_REFRESH_FAILED");
    await prisma.googleConnection.update({
      where: { id: connectionId },
      data: {
        encryptedAccessToken: encryptToken(credentials.access_token),
        tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
        // Google may rotate the refresh token; persist the new one when issued.
        ...(credentials.refresh_token ? { encryptedRefreshToken: encryptToken(credentials.refresh_token) } : {}),
        status: "ACTIVE",
        lastUsedAt: new Date(),
      },
    });
    return credentials.access_token;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const revoked = /invalid_grant|revoked|deleted/i.test(msg);
    await prisma.googleConnection.update({
      where: { id: connectionId },
      data: { status: revoked ? "REVOKED" : "NEEDS_REAUTH", lastUsedAt: new Date() },
    });
    throw new Error(revoked ? "CONNECTION_REVOKED" : "TOKEN_REFRESH_FAILED");
  }
}
export async function revokeConnection(connectionId: string): Promise<void> {
  const conn = await prisma.googleConnection.findUnique({ where: { id: connectionId } });
  if (!conn) return;
  try {
    const client = getOAuthClient();
    const refreshToken = decryptToken(conn.encryptedRefreshToken);
    await client.revokeToken(refreshToken);
  } catch { /* revoke is best-effort; still clear local tokens */ }
  await prisma.googleConnection.update({
    where: { id: connectionId },
    data: { status: "DISCONNECTED", encryptedAccessToken: null, encryptedRefreshToken: "revoked", tokenExpiresAt: null },
  });
}
export const _google = google;
