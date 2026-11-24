import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A-GGL-02: no-Redis is a dev-only posture. In production, token refresh
// without Redis must fail closed — never refresh unlocked, because two
// concurrent refreshes can clobber a rotated refresh token. These tests
// pin that with a rotating-token stub and no Redis.
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

describe("getValidAccessToken with no Redis (A-GGL-02)", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    delete process.env.REDIS_URL;
    delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
    mocks.findUnique.mockResolvedValue({
      ...CONN,
      status: "ACTIVE",
      encryptedAccessToken: null,
      tokenExpiresAt: null,
      encryptedRefreshToken: encryptToken("old-refresh-token", AAD),
    });
    mocks.update.mockResolvedValue({});
    mocks.refreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: "new-access-token",
        refresh_token: "rotated-refresh-token",
        expiry_date: Date.now() + 3_600_000,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...savedEnv };
  });

  it("fails closed in production: two concurrent refreshes write nothing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const results = await Promise.allSettled([getValidAccessToken("conn-1"), getValidAccessToken("conn-1")]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") expect(String(r.reason)).toContain("TOKEN_REFRESH_LOCK_UNAVAILABLE");
    }
    // Zero writes: no rotated token can be clobbered, and no refresh
    // ever reached Google.
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("still refreshes unlocked in non-production (single-instance dev)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const token = await getValidAccessToken("conn-1");
    expect(token).toBe("new-access-token");
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const written = mocks.update.mock.calls[0][0].data;
    expect(decryptToken(written.encryptedRefreshToken, AAD)).toBe("rotated-refresh-token");
  });
});
