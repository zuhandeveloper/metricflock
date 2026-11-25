import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A-GGL-14: a corrupt cached access token must not brick the connection.
// `getValidAccessToken` must fall through to the refresh flow when the
// fast-path (or lock double-check) decrypt fails, and only throw when
// both the access-token decrypt and the refresh fail — as the classified
// TOKEN_REFRESH_FAILED, never as a raw decrypt error. Redis is absent
// (unlocked dev path, like refresh-no-redis.test.ts); the no-Redis
// production fail-closed path is pinned there.
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  writeAudit: vi.fn(),
  refreshAccessToken: vi.fn(),
  setCredentials: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: { googleConnection: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, getRedis: () => null };
});
vi.mock("@metricflock/google/oauth", () => ({
  getOAuthClient: () => ({
    setCredentials: mocks.setCredentials,
    refreshAccessToken: mocks.refreshAccessToken,
  }),
}));

import { getValidAccessToken } from "@metricflock/google/tokens";
import { encryptToken, decryptToken, connectionAad } from "@metricflock/shared";

const CONN = {
  id: "conn-1",
  organizationId: "org-1",
  ownerType: "TEAM",
  ownerId: "team-1",
  googleAccountEmail: "a@example.com",
};
const AAD = connectionAad(CONN);

const validRefresh = () => encryptToken("old-refresh-token", AAD);
const corruptConn = (overrides: Record<string, unknown> = {}) => ({
  ...CONN,
  status: "ACTIVE",
  // Unexpired, so the fast path is taken — but the ciphertext cannot
  // be decrypted, so the call must fall through to refresh.
  encryptedAccessToken: encryptToken("old-access-token", AAD).slice(0, 24),
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  encryptedRefreshToken: validRefresh(),
  ...overrides,
});

describe("getValidAccessToken with a corrupt cached access token (A-GGL-14)", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    delete process.env.REDIS_URL;
    delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
    mocks.findUnique.mockResolvedValue(corruptConn());
    mocks.update.mockResolvedValue({});
    mocks.refreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: "fresh-access-token",
        refresh_token: "rotated-refresh-token",
        expiry_date: Date.now() + 3_600_000,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...savedEnv };
  });

  it("falls back to refresh when the cached access token is truncated", async () => {
    const token = await getValidAccessToken("conn-1");
    expect(token).toBe("fresh-access-token");
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const written = mocks.update.mock.calls[0][0].data;
    expect(decryptToken(written.encryptedAccessToken, AAD)).toBe("fresh-access-token");
  });

  it("falls back to refresh on an unknown key id (TOKEN_KEY_UNKNOWN)", async () => {
    const envelope = encryptToken("old-access-token", AAD).split(":");
    mocks.findUnique.mockResolvedValue(corruptConn({ encryptedAccessToken: `v1:deadbeef:${envelope[2]}` }));
    const token = await getValidAccessToken("conn-1");
    expect(token).toBe("fresh-access-token");
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("falls back to refresh on an AAD mismatch (token encrypted for another owner)", async () => {
    mocks.findUnique.mockResolvedValue(
      corruptConn({ encryptedAccessToken: encryptToken("old-access-token", "other-owner-aad") }),
    );
    const token = await getValidAccessToken("conn-1");
    expect(token).toBe("fresh-access-token");
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("falls back to refresh when the lock double-check decrypt fails", async () => {
    // First read: no usable cached token, so the fast path is skipped.
    // Second read (under the lock): a corrupt but unexpired token —
    // the double-check decrypt must fall through to refresh, not throw.
    mocks.findUnique
      .mockResolvedValueOnce(corruptConn({ encryptedAccessToken: null, tokenExpiresAt: null }))
      .mockResolvedValueOnce(corruptConn());
    const token = await getValidAccessToken("conn-1");
    expect(token).toBe("fresh-access-token");
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it("throws the classified TOKEN_REFRESH_FAILED when both tokens are corrupt", async () => {
    mocks.findUnique.mockResolvedValue(corruptConn({ encryptedRefreshToken: validRefresh().slice(0, 24) }));
    await expect(getValidAccessToken("conn-1")).rejects.toThrow("TOKEN_REFRESH_FAILED");
    // The refresh exchange was never reached — the refresh token itself
    // could not be decrypted.
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("still returns a valid cached access token without refreshing", async () => {
    mocks.findUnique.mockResolvedValue(corruptConn({ encryptedAccessToken: encryptToken("good-access-token", AAD) }));
    const token = await getValidAccessToken("conn-1");
    expect(token).toBe("good-access-token");
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
