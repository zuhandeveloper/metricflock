import { describe, it, expect, beforeEach, vi } from "vitest";

// A-DB-12: `getAuthorizedClientForIntegration` must never fetch a legacy
// MAPPED integration with `googleConnectionId = NULL` under another
// connection's credentials. Same mock shape as google-client.test.ts
// (Prisma, token refresher and OAuth client factory mocked; the scope
// check runs for real) — this file is separate because google-client.test.ts
// carries the A-DB-11 batch-lookup tests.
const mocks = vi.hoisted(() => ({
  websiteFindUnique: vi.fn(),
  connectionFindFirst: vi.fn(),
  getValidAccessToken: vi.fn(),
  setCredentials: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    website: { findUnique: mocks.websiteFindUnique },
    googleConnection: { findFirst: mocks.connectionFindFirst },
    websiteIntegration: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@metricflock/google/tokens", () => ({
  getValidAccessToken: mocks.getValidAccessToken,
}));
vi.mock("@metricflock/google/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/google/oauth")>();
  return { ...actual, getOAuthClient: () => ({ setCredentials: mocks.setCredentials }) };
});

import { getAuthorizedClientForIntegration } from "@metricflock/google/client";
import { GA4_SCOPES } from "@metricflock/google/oauth";

const WEBSITE = { id: "site-1", organizationId: "org-1", teamId: "team-1" };
// The audit's reproduction: connection A discovered the property, a newer
// website-level connection B (different Google account) was added later.
const CONN_A = {
  id: "conn-a",
  websiteId: null,
  teamId: "team-1",
  googleAccountEmail: "a@example.com",
  scopes: [...GA4_SCOPES],
};
const CONN_B = {
  id: "conn-b",
  websiteId: "site-1",
  googleAccountEmail: "b@example.com",
  scopes: [...GA4_SCOPES],
};

describe("getAuthorizedClientForIntegration — legacy NULL connection (A-DB-12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.websiteFindUnique.mockResolvedValue({ ...WEBSITE });
    mocks.getValidAccessToken.mockResolvedValue("access-token");
  });

  it("throws LEGACY_CONNECTION_MISSING for a NULL-connection integration even when a newer website connection exists", async () => {
    // The old fallback would have resolved connection B (most recently
    // updated website connection) and fetched A's property with B's token.
    mocks.connectionFindFirst.mockResolvedValue(CONN_B);
    await expect(
      getAuthorizedClientForIntegration("site-1", { googleConnectionId: null, provider: "GA4" }),
    ).rejects.toThrow("LEGACY_CONNECTION_MISSING");
    // No credential was ever minted: no website/team lookup, no token.
    expect(mocks.websiteFindUnique).not.toHaveBeenCalled();
    expect(mocks.connectionFindFirst).not.toHaveBeenCalled();
    expect(mocks.getValidAccessToken).not.toHaveBeenCalled();
    expect(mocks.setCredentials).not.toHaveBeenCalled();
  });

  it("throws LEGACY_CONNECTION_MISSING when the integration carries no connection key at all", async () => {
    mocks.connectionFindFirst.mockResolvedValue(CONN_B);
    await expect(getAuthorizedClientForIntegration("site-1", {})).rejects.toThrow("LEGACY_CONNECTION_MISSING");
    expect(mocks.getValidAccessToken).not.toHaveBeenCalled();
  });

  it("still authorizes with the mapping's own connection when one is set (DATA-5 preserved)", async () => {
    // Even with a newer website-level connection B present, the mapping's
    // own connection A is the one whose token is used.
    mocks.connectionFindFirst.mockResolvedValue(CONN_A);
    const { connection } = await getAuthorizedClientForIntegration("site-1", {
      googleConnectionId: "conn-a",
      provider: "GA4",
    });
    expect(mocks.getValidAccessToken).toHaveBeenCalledWith("conn-a");
    expect(mocks.getValidAccessToken).not.toHaveBeenCalledWith("conn-b");
    expect(connection.connectionId).toBe("conn-a");
  });
});
