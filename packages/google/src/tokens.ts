import crypto from "node:crypto";
import { google } from "googleapis";
import { prisma } from "@metricflock/db";
import { decryptToken, encryptToken, connectionAad, needsReencryption, getRedis } from "@metricflock/shared";
import { getOAuthClient } from "./oauth";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Per-connection refresh lock (OAUTH-8): concurrent refreshes of the same
// connection serialize on Redis so a rotated refresh token can never be
// overwritten by a stale one. Degrades to unlocked when Redis is not
// configured (single-instance dev) or the lock cannot be acquired in
// time (the double-checked expiry read still prevents most duplicates).
async function withRefreshLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  if (!redis) return fn();
  const key = `lock:token-refresh:${connectionId}`;
  const token = crypto.randomBytes(16).toString("hex");
  const deadline = Date.now() + 15_000;
  let acquired = false;
  while (Date.now() < deadline) {
    const ok = await redis.set(key, token, "PX", 30_000, "NX").catch(() => null);
    if (ok === "OK") {
      acquired = true;
      break;
    }
    await sleep(250);
  }
  if (!acquired) return fn();
  try {
    return await fn();
  } finally {
    await redis
      .eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        token,
      )
      .catch(() => {});
  }
}

// Only a structured invalid_grant (grant revoked/expired at Google) marks
// a connection REVOKED. Transient failures (5xx, network, config errors)
// must not flap the connection status (OAUTH-8).
function isInvalidGrant(err: unknown): boolean {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | null;
  if (e?.response?.data?.error === "invalid_grant") return true;
  return /invalid_grant/i.test(e?.message ?? "");
}

// Refresh an access token; handles rotation (new refresh token replaces old) and
// missing refresh token (existing authorizations may not return one) + revoked grants.
export async function getValidAccessToken(connectionId: string): Promise<string> {
  const conn = await prisma.googleConnection.findUnique({ where: { id: connectionId } });
  if (!conn) throw new Error("CONNECTION_NOT_FOUND");
  if (conn.status === "REVOKED" || conn.status === "DISCONNECTED") throw new Error("CONNECTION_REVOKED");
  const aad = connectionAad(conn);
  if (conn.encryptedAccessToken && conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() > Date.now() + 60_000) {
    return decryptToken(conn.encryptedAccessToken, aad);
  }
  return withRefreshLock(connectionId, async () => {
    // Double-check under the lock: another caller may have just refreshed.
    const fresh = await prisma.googleConnection.findUnique({ where: { id: connectionId } });
    if (!fresh) throw new Error("CONNECTION_NOT_FOUND");
    if (fresh.status === "REVOKED" || fresh.status === "DISCONNECTED") throw new Error("CONNECTION_REVOKED");
    if (fresh.encryptedAccessToken && fresh.tokenExpiresAt && fresh.tokenExpiresAt.getTime() > Date.now() + 60_000) {
      return decryptToken(fresh.encryptedAccessToken, aad);
    }
    if (!fresh.encryptedRefreshToken) throw new Error("MISSING_REFRESH_TOKEN");
    const refreshToken = decryptToken(fresh.encryptedRefreshToken, aad);
    const client = getOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    try {
      const { credentials } = await client.refreshAccessToken();
      if (!credentials.access_token) throw new Error("TOKEN_REFRESH_FAILED");
      await prisma.googleConnection.update({
        where: { id: connectionId },
        data: {
          encryptedAccessToken: encryptToken(credentials.access_token, aad),
          tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
          // Google may rotate the refresh token; persist the new one when
          // issued. Otherwise lazily re-encrypt the existing one when it
          // is still under a legacy/previous key (OAUTH-7 rotation).
          ...(credentials.refresh_token
            ? { encryptedRefreshToken: encryptToken(credentials.refresh_token, aad) }
            : needsReencryption(fresh.encryptedRefreshToken)
              ? { encryptedRefreshToken: encryptToken(refreshToken, aad) }
              : {}),
          status: "ACTIVE",
          lastUsedAt: new Date(),
        },
      });
      return credentials.access_token;
    } catch (err: unknown) {
      if (isInvalidGrant(err)) {
        await prisma.googleConnection.update({
          where: { id: connectionId },
          data: { status: "REVOKED", lastUsedAt: new Date() },
        });
        throw new Error("CONNECTION_REVOKED");
      }
      // Transient/provider error: leave the connection status untouched.
      throw new Error("TOKEN_REFRESH_FAILED");
    }
  });
}
export async function revokeConnection(connectionId: string): Promise<void> {
  const conn = await prisma.googleConnection.findUnique({ where: { id: connectionId } });
  if (!conn) return;
  try {
    const client = getOAuthClient();
    const refreshToken = decryptToken(conn.encryptedRefreshToken, connectionAad(conn));
    await client.revokeToken(refreshToken);
  } catch {
    /* revoke is best-effort; still clear local tokens */
  }
  await prisma.googleConnection.update({
    where: { id: connectionId },
    data: {
      status: "DISCONNECTED",
      encryptedAccessToken: null,
      // Empty string = no usable token (column is NOT NULL). Never store
      // sentinel words that could be mistaken for ciphertext (OAUTH-12).
      encryptedRefreshToken: "",
      tokenExpiresAt: null,
    },
  });
}
export const _google = google;
