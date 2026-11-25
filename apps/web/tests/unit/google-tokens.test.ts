import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// packages/google/src/tokens.ts — getValidAccessToken refresh flows and
// revokeConnection. Redis is a fake in-memory lock (NX semantics);
// Prisma + the OAuth client are mocked. The no-Redis production
// fail-closed path is pinned in refresh-no-redis.test.ts; this file
// covers the Redis-locked paths (lock error, fencing, rotation,
// lazy re-encryption, invalid_grant handling).
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  $transaction: vi.fn(),
  writeAudit: vi.fn(),
  refreshAccessToken: vi.fn(),
  revokeToken: vi.fn(),
  setCredentials: vi.fn(),
  getRedis: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    googleConnection: { findUnique: mocks.findUnique, update: mocks.update },
    websiteIntegration: { updateMany: mocks.updateMany },
    $transaction: mocks.$transaction,
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, getRedis: mocks.getRedis };
});
vi.mock("@metricflock/google/oauth", () => ({
  getOAuthClient: () => ({
    setCredentials: mocks.setCredentials,
    refreshAccessToken: mocks.refreshAccessToken,
    revokeToken: mocks.revokeToken,
  }),
}));

import { getValidAccessToken, revokeConnection } from "@metricflock/google/tokens";
import { encryptToken, decryptToken, connectionAad } from "@metricflock/shared";

const CONN = {
  id: "conn-1",
  organizationId: "org-1",
  ownerType: "TEAM",
  ownerId: "team-1",
  googleAccountEmail: "a@example.com",
};
const AAD = connectionAad(CONN);
const LOCK_KEY = "lock:token-refresh:conn-1";

function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string) => {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: vi.fn(async (_script: string, _n: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
}

const expiredConn = (overrides: Record<string, unknown> = {}) => ({
  ...CONN,
  status: "ACTIVE",
  encryptedAccessToken: null,
  tokenExpiresAt: null,
  encryptedRefreshToken: encryptToken("old-refresh-token", AAD),
  ...overrides,
});
const validConn = (overrides: Record<string, unknown> = {}) => ({
  ...CONN,
  status: "ACTIVE",
  encryptedAccessToken: encryptToken("fresh-access-token", AAD),
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  encryptedRefreshToken: encryptToken("old-refresh-token", AAD),
  ...overrides,
});
const refreshedCreds = (overrides: Record<string, unknown> = {}) => ({
  credentials: {
    access_token: "new-access-token",
    refresh_token: "rotated-refresh-token",
    expiry_date: Date.now() + 3_600_000,
    ...overrides,
  },
});

describe("getValidAccessToken (Redis-locked refresh)", () => {
  const savedEnv = { ...process.env };
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeRedis();
    mocks.getRedis.mockReturnValue(redis);
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
    mocks.findUnique.mockResolvedValue(expiredConn());
    mocks.update.mockResolvedValue({});
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.refreshAccessToken.mockResolvedValue(refreshedCreds());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...savedEnv };
  });

  it("returns a still-valid access token without refreshing", async () => {
    mocks.findUnique.mockResolvedValue(validConn());
    await expect(getValidAccessToken("conn-1")).resolves.toBe("fresh-access-token");
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.getRedis).not.toHaveBeenCalled();
  });

  it("refreshes when the token expires within the 60s grace window", async () => {
    mocks.findUnique.mockResolvedValue(validConn({ tokenExpiresAt: new Date(Date.now() + 30_000) }));
    await expect(getValidAccessToken("conn-1")).resolves.toBe("new-access-token");
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired token, persists rotation, and releases the lock", async () => {
    const token = await getValidAccessToken("conn-1");
    expect(token).toBe("new-access-token");
    expect(mocks.setCredentials).toHaveBeenCalledWith({ refresh_token: "old-refresh-token" });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const written = mocks.update.mock.calls[0][0].data;
    expect(decryptToken(written.encryptedAccessToken, AAD)).toBe("new-access-token");
    expect(decryptToken(written.encryptedRefreshToken, AAD)).toBe("rotated-refresh-token");
    expect(written.status).toBe("ACTIVE");
    expect(written.tokenExpiresAt).toBeInstanceOf(Date);
    expect(redis.store.size).toBe(0);
  });

  it("double-check under the lock: a token refreshed by another caller is reused", async () => {
    let calls = 0;
    mocks.findUnique.mockImplementation(async () => (++calls === 1 ? expiredConn() : validConn()));
    await expect(getValidAccessToken("conn-1")).resolves.toBe("fresh-access-token");
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("throws CONNECTION_NOT_FOUND when the connection does not exist", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("CONNECTION_NOT_FOUND");
  });

  it("throws CONNECTION_NOT_FOUND when the connection vanishes under the lock", async () => {
    let calls = 0;
    mocks.findUnique.mockImplementation(async () => (++calls === 1 ? expiredConn() : null));
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("CONNECTION_NOT_FOUND");
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
  });

  it.each(["REVOKED", "DISCONNECTED"])("throws CONNECTION_REVOKED for status %s", async (status) => {
    mocks.findUnique.mockResolvedValue(expiredConn({ status }));
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("CONNECTION_REVOKED");
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("throws CONNECTION_REVOKED when the connection is revoked under the lock", async () => {
    let calls = 0;
    mocks.findUnique.mockImplementation(async () =>
      ++calls === 1 ? expiredConn() : expiredConn({ status: "REVOKED" }),
    );
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("CONNECTION_REVOKED");
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("throws MISSING_REFRESH_TOKEN when there is no refresh token to use", async () => {
    mocks.findUnique.mockResolvedValue(expiredConn({ encryptedRefreshToken: "" }));
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("MISSING_REFRESH_TOKEN");
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("throws TOKEN_REFRESH_FAILED when Google returns no access token", async () => {
    mocks.refreshAccessToken.mockResolvedValue({ credentials: {} });
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("TOKEN_REFRESH_FAILED");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("marks the connection REVOKED and audits on a structured invalid_grant", async () => {
    const err = new Error("request failed") as Error & { response: { data: { error: string } } };
    err.response = { data: { error: "invalid_grant" } };
    mocks.refreshAccessToken.mockRejectedValue(err);
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("CONNECTION_REVOKED");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "conn-1" }, data: expect.objectContaining({ status: "REVOKED" }) }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        actorId: null,
        action: "google.connection.revoked",
        details: { reason: "invalid_grant", googleAccountEmail: "a@example.com" },
      }),
    );
  });

  it("marks the connection REVOKED on an invalid_grant carried in the message", async () => {
    mocks.refreshAccessToken.mockRejectedValue(new Error("invalid_grant: Token has been expired or revoked"));
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("CONNECTION_REVOKED");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REVOKED" }) }),
    );
  });

  it("leaves the connection status untouched on transient refresh failures", async () => {
    mocks.refreshAccessToken.mockRejectedValue(new Error("socket hang up"));
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("TOKEN_REFRESH_FAILED");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("a refresh timeout passes through as GOOGLE_API_TIMEOUT, not TOKEN_REFRESH_FAILED", async () => {
    mocks.refreshAccessToken.mockRejectedValue(new Error("GOOGLE_API_TIMEOUT: oauth.refreshAccessToken timed out"));
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("GOOGLE_API_TIMEOUT");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fails closed with TOKEN_REFRESH_LOCK_UNAVAILABLE when Redis errors on lock acquire", async () => {
    mocks.getRedis.mockReturnValue({
      set: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      get: vi.fn(async () => null),
      eval: vi.fn(async () => 0),
    });
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("TOKEN_REFRESH_LOCK_UNAVAILABLE");
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fencing: a lost lock plus a changed stored token skips the refresh-token overwrite", async () => {
    const changed = encryptToken("newer-rotated-token", AAD);
    let calls = 0;
    mocks.findUnique.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return expiredConn();
      return { encryptedRefreshToken: changed };
    });
    // The lock expires mid-refresh: the key is gone when lockHeld() runs.
    mocks.refreshAccessToken.mockImplementation(async () => {
      redis.store.delete(LOCK_KEY);
      return refreshedCreds();
    });
    const token = await getValidAccessToken("conn-1");
    expect(token).toBe("new-access-token");
    const written = mocks.update.mock.calls[0][0].data;
    expect(decryptToken(written.encryptedAccessToken, AAD)).toBe("new-access-token");
    expect(written).not.toHaveProperty("encryptedRefreshToken");
  });

  it("fencing: a lost lock with an unchanged stored token still writes the rotation", async () => {
    const stored = expiredConn();
    let calls = 0;
    mocks.findUnique.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return stored;
      return { encryptedRefreshToken: stored.encryptedRefreshToken };
    });
    mocks.refreshAccessToken.mockImplementation(async () => {
      redis.store.delete(LOCK_KEY);
      return refreshedCreds();
    });
    await getValidAccessToken("conn-1");
    const written = mocks.update.mock.calls[0][0].data;
    expect(decryptToken(written.encryptedRefreshToken, AAD)).toBe("rotated-refresh-token");
  });

  it("lazily re-encrypts a previous-key refresh token when Google issues no new one", async () => {
    const previousKey = crypto.randomBytes(32).toString("base64");
    const currentKey = crypto.randomBytes(32).toString("base64");
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", previousKey);
    const legacyCipher = encryptToken("old-refresh-token", AAD);
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", currentKey);
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS", previousKey);
    mocks.findUnique.mockResolvedValue(expiredConn({ encryptedRefreshToken: legacyCipher }));
    mocks.refreshAccessToken.mockResolvedValue({ credentials: { access_token: "new-access-token" } });
    await expect(getValidAccessToken("conn-1")).resolves.toBe("new-access-token");
    const written = mocks.update.mock.calls[0][0].data;
    expect(decryptToken(written.encryptedRefreshToken, AAD)).toBe("old-refresh-token");
    expect(written.encryptedRefreshToken).not.toBe(legacyCipher);
  });

  it("does not touch the refresh token when Google issues none and no re-encryption is due", async () => {
    mocks.refreshAccessToken.mockResolvedValue({ credentials: { access_token: "new-access-token" } });
    await getValidAccessToken("conn-1");
    const written = mocks.update.mock.calls[0][0].data;
    expect(written).not.toHaveProperty("encryptedRefreshToken");
    expect(decryptToken(written.encryptedAccessToken, AAD)).toBe("new-access-token");
  });

  it("fails closed when the refresh lock stays contended past its deadline", async () => {
    // acquireRefreshLock's default deadline is 15 s; fake timers drive
    // the poll loop without a real 15 s wait.
    vi.useFakeTimers();
    try {
      mocks.getRedis.mockReturnValue({
        set: vi.fn(async () => null),
        get: vi.fn(async () => null),
        eval: vi.fn(async () => 0),
      });
      const promise = getValidAccessToken("conn-1");
      const assertion = expect(promise).rejects.toThrow("TOKEN_REFRESH_LOCK_UNAVAILABLE");
      await vi.advanceTimersByTimeAsync(16_000);
      await assertion;
      expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing lock check counts as lock-lost and still writes the rotation", async () => {
    const stored = expiredConn();
    let calls = 0;
    mocks.findUnique.mockImplementation(async () => {
      calls++;
      if (calls <= 2) return stored;
      return { encryptedRefreshToken: stored.encryptedRefreshToken };
    });
    const flaky = makeRedis();
    flaky.get = vi.fn(async () => {
      throw new Error("redis down");
    });
    mocks.getRedis.mockReturnValue(flaky);
    await expect(getValidAccessToken("conn-1")).resolves.toBe("new-access-token");
    const written = mocks.update.mock.calls[0][0].data;
    expect(decryptToken(written.encryptedRefreshToken, AAD)).toBe("rotated-refresh-token");
  });

  it("a failing revocation audit is swallowed and the grant is still revoked", async () => {
    mocks.refreshAccessToken.mockRejectedValue(new Error("invalid_grant: Token has been expired or revoked"));
    mocks.writeAudit.mockRejectedValue(new Error("audit down"));
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("CONNECTION_REVOKED");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REVOKED" }) }),
    );
  });

  it("a failing lock release is swallowed and the refresh still succeeds", async () => {
    const flaky = makeRedis();
    flaky.eval = vi.fn(async () => {
      throw new Error("redis down");
    });
    mocks.getRedis.mockReturnValue(flaky);
    await expect(getValidAccessToken("conn-1")).resolves.toBe("new-access-token");
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("a non-Error refresh failure is a transient TOKEN_REFRESH_FAILED", async () => {
    mocks.refreshAccessToken.mockRejectedValue({ response: {} });
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("TOKEN_REFRESH_FAILED");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("revokeConnection", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
    mocks.findUnique.mockResolvedValue(expiredConn());
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 2 });
    // Array-form $transaction: run the operations through (the mocks
    // resolve plain values, so Promise.all is the faithful stand-in).
    mocks.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
    mocks.revokeToken.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...savedEnv };
  });

  it("revokes at Google and clears local tokens", async () => {
    await revokeConnection("conn-1");
    expect(mocks.revokeToken).toHaveBeenCalledWith("old-refresh-token");
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "conn-1" },
      data: {
        status: "DISCONNECTED",
        encryptedAccessToken: null,
        encryptedRefreshToken: "",
        tokenExpiresAt: null,
      },
    });
  });

  it("still clears local tokens when the Google revoke fails (best-effort)", async () => {
    mocks.revokeToken.mockRejectedValue(new Error("network down"));
    await revokeConnection("conn-1");
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DISCONNECTED" }) }),
    );
  });

  it("is a no-op for an unknown connection", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await revokeConnection("conn-1");
    expect(mocks.revokeToken).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("still clears local tokens when there is no stored refresh token to revoke", async () => {
    mocks.findUnique.mockResolvedValue(expiredConn({ encryptedRefreshToken: null }));
    await revokeConnection("conn-1");
    expect(mocks.revokeToken).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DISCONNECTED" }) }),
    );
  });

  it("unmaps MAPPED integrations in the same transaction and returns the count (A-GGL-06)", async () => {
    const count = await revokeConnection("conn-1");
    expect(count).toBe(2);
    expect(mocks.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.$transaction.mock.calls[0]![0]).toHaveLength(2);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { googleConnectionId: "conn-1", mappingStatus: "MAPPED" },
      data: { mappingStatus: "UNMAPPED", isPrimary: false },
    });
  });

  it("still unmaps when the Google revoke fails (best-effort)", async () => {
    mocks.revokeToken.mockRejectedValue(new Error("network down"));
    const count = await revokeConnection("conn-1");
    expect(count).toBe(2);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not touch integrations for an unknown connection", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const count = await revokeConnection("conn-1");
    expect(count).toBe(0);
    expect(mocks.revokeToken).not.toHaveBeenCalled();
    expect(mocks.$transaction).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
