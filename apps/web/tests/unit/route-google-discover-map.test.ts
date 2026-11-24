import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Coverage-gap closure: Google property discovery + mapping routes.
// Pattern follows routes-v1-analytics.test.ts — mocked Prisma + auth +
// Google clients; unauthenticated → 401, cross-tenant → 404, valid →
// 200 shape, plus invalid-input and provider-error cases.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  assertWebsiteManageAccess: vi.fn(),
  assertConnectionVisible: vi.fn(),
  assertConnectionScopeForWebsite: vi.fn(),
  writeAudit: vi.fn(),
  connFindFirst: vi.fn(),
  googlePropertyFindMany: vi.fn(),
  googlePropertyUpsert: vi.fn(),
  scPropertyFindMany: vi.fn(),
  scPropertyUpsert: vi.fn(),
  adsenseFindMany: vi.fn(),
  adsenseUpsert: vi.fn(),
  adManagerFindMany: vi.fn(),
  integrationUpdateMany: vi.fn(),
  integrationUpsert: vi.fn(),
  websiteUpdateMany: vi.fn(),
  tx: vi.fn(),
  getValidAccessToken: vi.fn(),
  getOAuthClient: vi.fn(),
  listGa4Properties: vi.fn(),
  listSearchConsoleSites: vi.fn(),
  listAdSenseAccounts: vi.fn(),
  invalidateWebsiteCache: vi.fn(),
  invalidateWebsiteSnapshots: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    googleConnection: { findFirst: mocks.connFindFirst },
    googleProperty: { findMany: mocks.googlePropertyFindMany, upsert: mocks.googlePropertyUpsert },
    searchConsoleProperty: { findMany: mocks.scPropertyFindMany, upsert: mocks.scPropertyUpsert },
    adSenseAccount: { findMany: mocks.adsenseFindMany, upsert: mocks.adsenseUpsert },
    adManagerNetwork: { findMany: mocks.adManagerFindMany },
    $transaction: mocks.tx,
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/db/snapshots", () => ({ invalidateWebsiteSnapshots: mocks.invalidateWebsiteSnapshots }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    assertWebsiteManageAccess: mocks.assertWebsiteManageAccess,
    assertConnectionVisible: mocks.assertConnectionVisible,
    assertConnectionScopeForWebsite: mocks.assertConnectionScopeForWebsite,
  };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, invalidateWebsiteCache: mocks.invalidateWebsiteCache };
});
vi.mock("@metricflock/google/tokens", () => ({ getValidAccessToken: mocks.getValidAccessToken }));
vi.mock("@metricflock/google/discovery", () => ({
  listGa4Properties: mocks.listGa4Properties,
  listSearchConsoleSites: mocks.listSearchConsoleSites,
  listAdSenseAccounts: mocks.listAdSenseAccounts,
}));
vi.mock("@metricflock/google/oauth", () => ({ getOAuthClient: mocks.getOAuthClient }));

import { POST as discoverPost } from "@/app/api/google/properties/discover/route";
import { POST as mapPost } from "@/app/api/google/properties/map/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const unauth = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
const jsonReq = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const conn = { id: "conn1", organizationId: "org1", googleAccountEmail: "ga@example.com" };
const website = { id: "w1", organizationId: "org1", teamId: "t1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.assertWebsiteManageAccess.mockResolvedValue(website);
  mocks.assertConnectionVisible.mockResolvedValue(undefined);
  mocks.assertConnectionScopeForWebsite.mockImplementation(() => undefined);
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.invalidateWebsiteCache.mockResolvedValue(undefined);
  mocks.invalidateWebsiteSnapshots.mockResolvedValue(undefined);
  mocks.tx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      websiteIntegration: { updateMany: mocks.integrationUpdateMany, upsert: mocks.integrationUpsert },
      website: { updateMany: mocks.websiteUpdateMany },
    }),
  );
  mocks.integrationUpsert.mockImplementation(async ({ create }: { create: unknown }) => ({
    id: "int1",
    ...(create as object),
  }));
});

describe("POST /api/google/properties/discover", () => {
  const url = "http://localhost/api/google/properties/discover";
  const ga4Items = [{ propertyId: "properties/123", displayName: "Site GA4", accountId: "accounts/1" }];
  beforeEach(() => {
    mocks.connFindFirst.mockResolvedValue(conn);
    mocks.getValidAccessToken.mockResolvedValue("access-token");
    mocks.getOAuthClient.mockReturnValue({ setCredentials: vi.fn() });
    mocks.listGa4Properties.mockResolvedValue({ items: ga4Items, truncated: false });
    mocks.listSearchConsoleSites.mockResolvedValue({
      items: [{ siteUrl: "https://site.example/", permissionLevel: "siteOwner" }],
      truncated: false,
    });
    mocks.listAdSenseAccounts.mockResolvedValue({
      items: [{ accountId: "pub-123", displayName: "AdSense" }],
      truncated: false,
    });
    mocks.googlePropertyUpsert.mockResolvedValue({});
    mocks.scPropertyUpsert.mockResolvedValue({});
    mocks.adsenseUpsert.mockResolvedValue({});
  });

  it("unauthenticated → 401; invalid input → 400; unknown connection → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await discoverPost(jsonReq(url, { connectionId: "conn1" }))).status).toBe(401);
    expect((await discoverPost(jsonReq(url, {}))).status).toBe(400);
    mocks.connFindFirst.mockResolvedValueOnce(null);
    const missing = await discoverPost(jsonReq(url, { connectionId: "conn9" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
  });
  it("foreign-team connection → 404 (indistinguishable from missing)", async () => {
    mocks.assertConnectionVisible.mockRejectedValueOnce(new Error("NOPE"));
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    expect(mocks.listGa4Properties).not.toHaveBeenCalled();
  });
  it("valid → 200 with all three providers + upserts each discovered item", async () => {
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ga4).toEqual(ga4Items);
    expect(body.searchConsole).toHaveLength(1);
    expect(body.adsense).toHaveLength(1);
    expect(body.errors).toBeUndefined();
    expect(mocks.getValidAccessToken).toHaveBeenCalledWith("conn1");
    expect(mocks.googlePropertyUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.scPropertyUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.adsenseUpsert).toHaveBeenCalledTimes(1);
  });
  it("provider failures are classified per provider, not a blanket error", async () => {
    mocks.listGa4Properties.mockRejectedValueOnce(
      Object.assign(new Error("PERMISSION_DENIED"), {
        response: { data: { error: { status: "PERMISSION_DENIED", message: "denied", details: [] } } },
      }),
    );
    mocks.listSearchConsoleSites.mockRejectedValueOnce(new Error("API analytics.googleapis.com has not been used"));
    mocks.listAdSenseAccounts.mockRejectedValueOnce(new Error("boom"));
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ga4).toEqual([]);
    expect(body.errors).toEqual({
      ga4: "permission_denied",
      searchConsole: "api_not_enabled",
      adsense: "provider_error",
    });
    expect(mocks.googlePropertyUpsert).not.toHaveBeenCalled();
  });
  it("unauthorized provider error → unauthorized classification", async () => {
    mocks.listGa4Properties.mockRejectedValueOnce(new Error("invalid_grant: bad token"));
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect((await res.json()).errors).toEqual({ ga4: "unauthorized" });
  });
  it("truncated results + partial errors are surfaced, not hidden", async () => {
    mocks.listGa4Properties.mockResolvedValueOnce({
      items: ga4Items,
      truncated: true,
      errors: ["accounts/2 skipped"],
    });
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    const body = await res.json();
    expect(body.truncated).toEqual({ ga4: true });
    expect(body.partial).toEqual({ ga4Accounts: ["accounts/2 skipped"] });
  });
  it("token fetch failure → 502 discovery_failed", async () => {
    mocks.getValidAccessToken.mockRejectedValueOnce(new Error("refresh failed"));
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "discovery_failed" });
  });
});

describe("POST /api/google/properties/map", () => {
  const url = "http://localhost/api/google/properties/map";
  const base = { websiteId: "w1", provider: "GA4", externalId: "properties/123" };
  beforeEach(() => {
    mocks.googlePropertyFindMany.mockResolvedValue([{ id: "gp1", connectionId: "conn1" }]);
    mocks.scPropertyFindMany.mockResolvedValue([{ id: "sc1", connectionId: "conn1" }]);
    mocks.adsenseFindMany.mockResolvedValue([{ id: "ad1", connectionId: "conn1" }]);
    mocks.adManagerFindMany.mockResolvedValue([{ id: "am1", connectionId: "conn1" }]);
    mocks.connFindFirst.mockResolvedValue({ teamId: "t1", websiteId: null, ownerType: "TEAM", ownerId: "t1" });
    mocks.integrationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.websiteUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("unauthenticated → 401; invalid input → 400; cross-tenant website → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await mapPost(jsonReq(url, base))).status).toBe(401);
    expect((await mapPost(jsonReq(url, { websiteId: "w1", provider: "NOPE", externalId: "x" }))).status).toBe(400);
    mocks.assertWebsiteManageAccess.mockRejectedValueOnce(new Error("NOPE"));
    const cross = await mapPost(jsonReq(url, base));
    expect(cross.status).toBe(404);
    expect(await cross.json()).toMatchObject({ error: "not_found_or_forbidden" });
  });
  it("undiscovered property → 400 property_not_discovered; ambiguous → 400 ambiguous_property", async () => {
    mocks.googlePropertyFindMany.mockResolvedValueOnce([]);
    const missing = await mapPost(jsonReq(url, base));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "property_not_discovered" });
    mocks.googlePropertyFindMany.mockResolvedValueOnce([
      { id: "gp1", connectionId: "conn1" },
      { id: "gp2", connectionId: "conn2" },
    ]);
    const ambiguous = await mapPost(jsonReq(url, base));
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ error: "ambiguous_property" });
  });
  it("each provider resolves through its own discovered-property table", async () => {
    for (const [provider, mock] of [
      ["SEARCH_CONSOLE", mocks.scPropertyFindMany],
      ["ADSENSE", mocks.adsenseFindMany],
      ["AD_MANAGER", mocks.adManagerFindMany],
    ] as const) {
      const res = await mapPost(jsonReq(url, { ...base, provider, externalId: "ext-1" }));
      expect(res.status).toBe(200);
      expect(mock).toHaveBeenCalled();
    }
    expect(mocks.integrationUpsert).toHaveBeenCalledTimes(3);
  });
  it("resolved connection missing → 404; invisible connection → 404", async () => {
    mocks.connFindFirst.mockResolvedValueOnce(null);
    const missing = await mapPost(jsonReq(url, base));
    expect(missing.status).toBe(404);
    mocks.assertConnectionVisible.mockRejectedValueOnce(new Error("NOPE"));
    const hidden = await mapPost(jsonReq(url, base));
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ error: "not_found_or_forbidden" });
  });
  it("connection scope mismatch → 400 connection_scope_mismatch", async () => {
    mocks.assertConnectionScopeForWebsite.mockImplementationOnce(() => {
      throw new Error("SCOPE");
    });
    const res = await mapPost(jsonReq(url, base));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "connection_scope_mismatch" });
  });
  it("primary mapping demotes the previous primary, upserts, audits + invalidates", async () => {
    const res = await mapPost(jsonReq(url, { ...base, isPrimary: true, resourceName: "Site GA4" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.integration).toMatchObject({ provider: "GA4", externalId: "properties/123", isPrimary: true });
    expect(mocks.integrationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { websiteId: "w1", provider: "GA4", isPrimary: true } }),
    );
    expect(mocks.integrationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { websiteId_provider_externalId: { websiteId: "w1", provider: "GA4", externalId: "properties/123" } },
      }),
    );
    expect(mocks.websiteUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "w1", status: "PENDING_SETUP" } }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "google.property.mapped", entityType: "Website", entityId: "w1" }),
    );
    expect(mocks.invalidateWebsiteCache).toHaveBeenCalledWith("org1", "w1");
    expect(mocks.invalidateWebsiteSnapshots).toHaveBeenCalledWith("w1");
  });
  it("non-primary mapping skips the demote step", async () => {
    await mapPost(jsonReq(url, base));
    expect(mocks.integrationUpdateMany).not.toHaveBeenCalled();
  });
});
