import { describe, it, expect, beforeEach, vi } from "vitest";

// packages/google/src/client.ts — connection resolution + authorized
// clients. Prisma, the token refresher and the OAuth client factory are
// mocked; the scope check (missingScopesForProvider) runs for real.
const mocks = vi.hoisted(() => ({
  websiteFindUnique: vi.fn(),
  connectionFindFirst: vi.fn(),
  integrationFindFirst: vi.fn(),
  getValidAccessToken: vi.fn(),
  setCredentials: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    website: { findUnique: mocks.websiteFindUnique },
    googleConnection: { findFirst: mocks.connectionFindFirst },
    websiteIntegration: { findFirst: mocks.integrationFindFirst },
  },
}));
vi.mock("@metricflock/google/tokens", () => ({
  getValidAccessToken: mocks.getValidAccessToken,
}));
vi.mock("@metricflock/google/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/google/oauth")>();
  return { ...actual, getOAuthClient: () => ({ setCredentials: mocks.setCredentials }) };
});

import {
  resolveConnectionForWebsite,
  getAuthorizedClientForWebsite,
  getAuthorizedClientForIntegration,
  getPrimaryIntegration,
  _google,
} from "@metricflock/google/client";
import { GA4_SCOPES } from "@metricflock/google/oauth";

const WEBSITE = { id: "site-1", organizationId: "org-1", teamId: "team-1" };
const SITE_CONN = { id: "conn-site", googleAccountEmail: "site@example.com" };
const TEAM_CONN = { id: "conn-team", googleAccountEmail: "team@example.com" };

describe("resolveConnectionForWebsite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.websiteFindUnique.mockResolvedValue({ ...WEBSITE });
    mocks.connectionFindFirst.mockResolvedValue(null);
  });

  it("throws NOT_FOUND_OR_FORBIDDEN when the website does not exist", async () => {
    mocks.websiteFindUnique.mockResolvedValue(null);
    await expect(resolveConnectionForWebsite("missing")).rejects.toThrow("NOT_FOUND_OR_FORBIDDEN");
    expect(mocks.connectionFindFirst).not.toHaveBeenCalled();
  });

  it("prefers the website-level connection over the team connection", async () => {
    mocks.connectionFindFirst.mockResolvedValueOnce(SITE_CONN);
    const out = await resolveConnectionForWebsite("site-1");
    expect(out).toEqual({
      status: "connected",
      connectionId: "conn-site",
      level: "WEBSITE",
      googleAccountEmail: "site@example.com",
    });
    expect(mocks.connectionFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.connectionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-1", websiteId: "site-1" }),
      }),
    );
  });

  it("falls back to the team connection when there is no website connection", async () => {
    mocks.connectionFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(TEAM_CONN);
    const out = await resolveConnectionForWebsite("site-1");
    expect(out).toEqual({
      status: "connected",
      connectionId: "conn-team",
      level: "TEAM",
      googleAccountEmail: "team@example.com",
    });
    expect(mocks.connectionFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: expect.objectContaining({ teamId: "team-1" }) }),
    );
  });

  it("returns not_connected when neither level has a connection", async () => {
    const out = await resolveConnectionForWebsite("site-1");
    expect(out).toEqual({ status: "not_connected", connectionId: null, level: null, googleAccountEmail: null });
    expect(mocks.connectionFindFirst).toHaveBeenCalledTimes(2);
  });

  it("does not look up a team connection when the website has no team", async () => {
    mocks.websiteFindUnique.mockResolvedValue({ ...WEBSITE, teamId: null });
    const out = await resolveConnectionForWebsite("site-1");
    expect(out.status).toBe("not_connected");
    expect(mocks.connectionFindFirst).toHaveBeenCalledTimes(1);
  });
});

describe("getAuthorizedClientForWebsite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.websiteFindUnique.mockResolvedValue({ ...WEBSITE });
    mocks.connectionFindFirst.mockResolvedValue(SITE_CONN);
    mocks.getValidAccessToken.mockResolvedValue("access-token-1");
  });

  it("returns an authorized client with the resolved connection", async () => {
    const { auth, connection } = await getAuthorizedClientForWebsite("site-1");
    expect(mocks.getValidAccessToken).toHaveBeenCalledWith("conn-site");
    expect(mocks.setCredentials).toHaveBeenCalledWith({ access_token: "access-token-1" });
    expect(auth).toBeDefined();
    expect(connection).toEqual({
      status: "connected",
      connectionId: "conn-site",
      level: "WEBSITE",
      googleAccountEmail: "site@example.com",
    });
  });

  it("throws CONNECTION_REQUIRED when nothing is connected", async () => {
    mocks.connectionFindFirst.mockResolvedValue(null);
    await expect(getAuthorizedClientForWebsite("site-1")).rejects.toThrow("CONNECTION_REQUIRED");
    expect(mocks.getValidAccessToken).not.toHaveBeenCalled();
  });
});

describe("getAuthorizedClientForIntegration (DATA-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.websiteFindUnique.mockResolvedValue({ organizationId: "org-1" });
    mocks.getValidAccessToken.mockResolvedValue("access-token-2");
  });

  const connRow = (overrides: Record<string, unknown> = {}) => ({
    id: "conn-9",
    websiteId: "site-1",
    googleAccountEmail: "owner@example.com",
    scopes: [...GA4_SCOPES],
    ...overrides,
  });

  it("authorizes with the mapping's own connection at WEBSITE level", async () => {
    mocks.connectionFindFirst.mockResolvedValue(connRow());
    const { connection } = await getAuthorizedClientForIntegration("site-1", {
      googleConnectionId: "conn-9",
      provider: "GA4",
    });
    expect(mocks.getValidAccessToken).toHaveBeenCalledWith("conn-9");
    expect(mocks.setCredentials).toHaveBeenCalledWith({ access_token: "access-token-2" });
    expect(connection).toEqual({
      status: "connected",
      connectionId: "conn-9",
      level: "WEBSITE",
      googleAccountEmail: "owner@example.com",
    });
  });

  it("reports TEAM level when the connection belongs to another website", async () => {
    mocks.connectionFindFirst.mockResolvedValue(connRow({ websiteId: "site-other" }));
    const { connection } = await getAuthorizedClientForIntegration("site-1", { googleConnectionId: "conn-9" });
    expect(connection.level).toBe("TEAM");
  });

  it("throws NOT_FOUND_OR_FORBIDDEN when the website does not exist", async () => {
    mocks.websiteFindUnique.mockResolvedValue(null);
    await expect(getAuthorizedClientForIntegration("missing", { googleConnectionId: "conn-9" })).rejects.toThrow(
      "NOT_FOUND_OR_FORBIDDEN",
    );
  });

  it("throws CONNECTION_REQUIRED when the mapping's connection is gone", async () => {
    mocks.connectionFindFirst.mockResolvedValue(null);
    await expect(getAuthorizedClientForIntegration("site-1", { googleConnectionId: "conn-9" })).rejects.toThrow(
      "CONNECTION_REQUIRED",
    );
    expect(mocks.getValidAccessToken).not.toHaveBeenCalled();
  });

  it("fails fast with SCOPE_MISSING when the connection lacks the provider scope", async () => {
    mocks.connectionFindFirst.mockResolvedValue(connRow({ scopes: [] }));
    await expect(
      getAuthorizedClientForIntegration("site-1", { googleConnectionId: "conn-9", provider: "GA4" }),
    ).rejects.toThrow("SCOPE_MISSING");
    expect(mocks.getValidAccessToken).not.toHaveBeenCalled();
  });

  it("skips the scope check when no provider is given", async () => {
    mocks.connectionFindFirst.mockResolvedValue(connRow({ scopes: [] }));
    const { connection } = await getAuthorizedClientForIntegration("site-1", { googleConnectionId: "conn-9" });
    expect(connection.status).toBe("connected");
    expect(mocks.getValidAccessToken).toHaveBeenCalledWith("conn-9");
  });

  it("falls back to website→team resolution for legacy mappings without a connection", async () => {
    mocks.websiteFindUnique.mockResolvedValue({ ...WEBSITE });
    mocks.connectionFindFirst.mockResolvedValue(SITE_CONN);
    const { connection } = await getAuthorizedClientForIntegration("site-1", {});
    expect(connection.level).toBe("WEBSITE");
    expect(mocks.getValidAccessToken).toHaveBeenCalledWith("conn-site");
  });
});

describe("getPrimaryIntegration", () => {
  it("queries the newest primary MAPPED integration", async () => {
    const row = { id: "int-1", externalId: "123456" };
    mocks.integrationFindFirst.mockResolvedValue(row);
    await expect(getPrimaryIntegration("site-1", "GA4")).resolves.toBe(row);
    expect(mocks.integrationFindFirst).toHaveBeenCalledWith({
      where: { websiteId: "site-1", provider: "GA4", mappingStatus: "MAPPED" },
      orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
    });
  });

  it("re-exports the googleapis namespace for callers that need it", () => {
    expect(_google).toBeDefined();
    expect(typeof _google.auth.OAuth2).toBe("function");
  });
});
