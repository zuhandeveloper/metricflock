import crypto from "node:crypto";
import { google } from "googleapis";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import {
  decryptToken,
  encryptToken,
  connectionAad,
  needsReencryption,
  getRedis,
  incr,
  createLogger,
} from "@metricflock/shared";
import { getOAuthClient } from "./oauth";
import { isGoogleTimeoutError, withGoogleTimeout } from "./timeout";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = createLogger("token-refresh");

// Per-connection refresh lock (OAUTH-8, hardened in Phase 3 / F-3.2):
// concurrent refreshes of the same connection serialize on Redis so a
// rotated refresh token can never be overwritten by a stale one.
//
// Fail-closed policy: when Redis is configured, a refresh that cannot
// acquire the lock (Redis error, or contention past the deadline) throws
// TOKEN_REFRESH_LOCK_UNAVAILABLE — a retryable error — instead of
// refreshing unlocked and risking a rotated-token clobber. A fencing check
// before the DB write covers the lock-TTL-expiry race (see
// getValidAccessToken).
//
// No-Redis is a DEV-ONLY posture (A-GGL-02): without Redis there is no
// lock at all, and on multi-instance production (Vercel/serverless) two
// concurrent refreshes can both read the old refresh token and the loser
// overwrites the winner's rotated token — or the now-invalid old one —
// leaving the stored refresh token invalid. So when REDIS_URL is unset
// AND NODE_ENV is production, refresh fails closed with
// TOKEN_REFRESH_LOCK_UNAVAILABLE instead of refreshing unlocked.
// In non-production, unlocked refresh is still allowed (single-instance
// dev), counted + logged. Production without Redis is unsupported —
// see docs/deployment.md and docs/env-config.md.
type RedisLike = {
  set(key: string, value: string, mode: string, ttl: number, nx: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export async function acquireRefreshLock(
  redis: RedisLike,
  key: string,
  token: string,
  opts: { ttlMs?: number; deadlineMs?: number; pollMs?: number } = {},
): Promise<"acquired" | "timeout" | "error"> {
  const ttlMs = opts.ttlMs ?? 30_000;
  const deadline = Date.now() + (opts.deadlineMs ?? 15_000);
  const pollMs = opts.pollMs ?? 250;
  while (Date.now() < deadline) {
    let ok: string | null;
    try {
      ok = await redis.set(key, token, "PX", ttlMs, "NX");
    } catch {
      return "error";
    }
    if (ok === "OK") return "acquired";
    await sleep(pollMs);
  }
  return "timeout";
}

async function withRefreshLock<T>(
  connectionId: string,
  fn: (lockHeld: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  const redis = getRedis();
  if (!redis) {
    // A-GGL-02: no-Redis is dev-only. In production there is no lock and
    // no fencing (lockHeld is hard-wired true below), so concurrent
    // refreshes can clobber a rotated refresh token — fail closed.
    if (process.env.NODE_ENV === "production") {
      incr("token_refresh.no_redis_production");
      log.error(
        "Redis not configured in production — token refresh fails closed; set REDIS_URL (no-Redis is dev-only)",
        { connectionId },
      );
      throw new Error("TOKEN_REFRESH_LOCK_UNAVAILABLE");
    }
    incr("token_refresh.unlocked_no_redis");
    log.warn("Redis not configured — token refresh runs unlocked (single-instance dev mode only)", {
      connectionId,
    });
    return fn(async () => true);
  }
  const key = `lock:token-refresh:${connectionId}`;
  const token = crypto.randomBytes(16).toString("hex");
  const outcome = await acquireRefreshLock(redis as unknown as RedisLike, key, token);
  if (outcome === "error") {
    incr("token_refresh.lock_error");
    log.error("Redis error while acquiring refresh lock — failing closed", { connectionId });
    throw new Error("TOKEN_REFRESH_LOCK_UNAVAILABLE");
  }
  if (outcome === "timeout") {
    incr("token_refresh.lock_timeout");
    log.error("Refresh lock contended past deadline — failing closed", { connectionId });
    throw new Error("TOKEN_REFRESH_LOCK_UNAVAILABLE");
  }
  const lockHeld = async () => {
    try {
      return (await redis.get(key)) === token;
    } catch {
      return false;
    }
  };
  try {
    return await fn(lockHeld);
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
  return withRefreshLock(connectionId, async (lockHeld) => {
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
      // A-GGL-03: the refresh exchange is bounded (google-auth-library
      // takes no timeout option, so the race in withGoogleTimeout is
      // the bound). A timeout is rethrown unchanged by the catch below
      // so it stays classifiable as temporarily_unavailable.
      const { credentials } = await withGoogleTimeout(client.refreshAccessToken(), "oauth.refreshAccessToken");
      if (!credentials.access_token) throw new Error("TOKEN_REFRESH_FAILED");
      // Fencing (F-3.2): if our lock expired mid-refresh and another
      // refresher already stored a (possibly rotated) refresh token, do
      // NOT overwrite it with ours — the stored one is newer. Our access
      // token is still valid and safe to store/return.
      let skipRefreshTokenWrite = false;
      if (!(await lockHeld())) {
        const now = await prisma.googleConnection.findUnique({
          where: { id: connectionId },
          select: { encryptedRefreshToken: true },
        });
        if (now && now.encryptedRefreshToken !== fresh.encryptedRefreshToken) {
          skipRefreshTokenWrite = true;
          incr("token_refresh.fenced");
          log.warn("Refresh lock lost and stored refresh token changed — skipping refresh-token overwrite", {
            connectionId,
          });
        }
      }
      await prisma.googleConnection.update({
        where: { id: connectionId },
        data: {
          encryptedAccessToken: encryptToken(credentials.access_token, aad),
          tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
          // Google may rotate the refresh token; persist the new one when
          // issued. Otherwise lazily re-encrypt the existing one when it
          // is still under a legacy/previous key (OAUTH-7 rotation).
          ...(!skipRefreshTokenWrite && credentials.refresh_token
            ? { encryptedRefreshToken: encryptToken(credentials.refresh_token, aad) }
            : !skipRefreshTokenWrite && needsReencryption(fresh.encryptedRefreshToken)
              ? { encryptedRefreshToken: encryptToken(refreshToken, aad) }
              : {}),
          status: "ACTIVE",
          lastUsedAt: new Date(),
        },
      });
      return credentials.access_token;
    } catch (err: unknown) {
      // A-GGL-03: a refresh timeout is transient, not a token failure —
      // let GOOGLE_API_TIMEOUT through unchanged (it is not in the sync
      // engine's TOKEN_ERRORS set, so it retries; and the analytics
      // classifier maps it to temporarily_unavailable). Collapsing it
      // into TOKEN_REFRESH_FAILED would mislabel it as terminal.
      if (isGoogleTimeoutError(err)) throw err;
      if (isInvalidGrant(err)) {
        await prisma.googleConnection.update({
          where: { id: connectionId },
          data: { status: "REVOKED", lastUsedAt: new Date() },
        });
        // DB-10: worker-side revocation is audited too (actor = system).
        await writeAudit({
          organizationId: fresh.organizationId,
          actorId: null,
          action: "google.connection.revoked",
          entityType: "GoogleConnection",
          entityId: connectionId,
          details: { reason: "invalid_grant", googleAccountEmail: fresh.googleAccountEmail },
        }).catch(() => undefined);
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
    // A-GGL-03: bounded like the refresh exchange; revoke is best-effort.
    await withGoogleTimeout(client.revokeToken(refreshToken), "oauth.revokeToken");
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
