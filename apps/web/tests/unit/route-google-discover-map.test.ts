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
  googlePropertyCreateMany: vi.fn(),
  googlePropertyDeleteMany: vi.fn(),
  scPropertyFindMany: vi.fn(),
  scPropertyUpsert: vi.fn(),
  scPropertyCreateMany: vi.fn(),
  scPropertyDeleteMany: vi.fn(),
  adsenseFindMany: vi.fn(),
  adsenseUpsert: vi.fn(),
  adsenseCreateMany: vi.fn(),
  adsenseDeleteMany: vi.fn(),
  adManagerFindMany: vi.fn(),
  adManagerUpsert: vi.fn(),
  adManagerCreateMany: vi.fn(),
  adManagerDeleteMany: vi.fn(),
  integrationFindMany: vi.fn(),
  integrationUpdateMany: vi.fn(),
  integrationUpsert: vi.fn(),
  websiteUpdateMany: vi.fn(),
  tx: vi.fn(),
  getValidAccessToken: vi.fn(),
  getOAuthClient: vi.fn(),
  listGa4Properties: vi.fn(),
  listSearchConsoleSites: vi.fn(),
  listAdSenseAccounts: vi.fn(),
  listAdManagerNetworks: vi.fn(),
  adManagerEnabled: vi.fn(),
  invalidateWebsiteCache: vi.fn(),
  invalidateWebsiteSnapshots: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    googleConnection: { findFirst: mocks.connFindFirst },
    googleProperty: {
      findMany: mocks.googlePropertyFindMany,
      upsert: mocks.googlePropertyUpsert,
      createMany: mocks.googlePropertyCreateMany,
      deleteMany: mocks.googlePropertyDeleteMany,
    },
    searchConsoleProperty: {
      findMany: mocks.scPropertyFindMany,
      upsert: mocks.scPropertyUpsert,
      createMany: mocks.scPropertyCreateMany,
      deleteMany: mocks.scPropertyDeleteMany,
    },
    adSenseAccount: {
      findMany: mocks.adsenseFindMany,
      upsert: mocks.adsenseUpsert,
      createMany: mocks.adsenseCreateMany,
      deleteMany: mocks.adsenseDeleteMany,
    },
    adManagerNetwork: {
      findMany: mocks.adManagerFindMany,
      upsert: mocks.adManagerUpsert,
      createMany: mocks.adManagerCreateMany,
      deleteMany: mocks.adManagerDeleteMany,
    },
    websiteIntegration: { findMany: mocks.integrationFindMany },
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
vi.mock("@metricflock/google/ad-manager", () => ({
  listAdManagerNetworks: mocks.listAdManagerNetworks,
  adManagerEnabled: mocks.adManagerEnabled,
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
    mocks.googlePropertyCreateMany.mockResolvedValue({ count: 1 });
    mocks.scPropertyUpsert.mockResolvedValue({});
    mocks.scPropertyCreateMany.mockResolvedValue({ count: 1 });
    mocks.adsenseUpsert.mockResolvedValue({});
    mocks.adsenseCreateMany.mockResolvedValue({ count: 1 });
    // A-GGL-10 defaults: Ad Manager disabled (existing tests cover the
    // three-provider path), no previously discovered rows (prune no-op).
    mocks.adManagerEnabled.mockReturnValue(false);
    mocks.listAdManagerNetworks.mockResolvedValue([]);
    mocks.adManagerUpsert.mockResolvedValue({});
    mocks.adManagerCreateMany.mockResolvedValue({ count: 1 });
    mocks.googlePropertyFindMany.mockResolvedValue([]);
    mocks.scPropertyFindMany.mockResolvedValue([]);
    mocks.adsenseFindMany.mockResolvedValue([]);
    mocks.adManagerFindMany.mockResolvedValue([]);
    mocks.integrationFindMany.mockResolvedValue([]);
    mocks.googlePropertyDeleteMany.mockResolvedValue({ count: 0 });
    mocks.scPropertyDeleteMany.mockResolvedValue({ count: 0 });
    mocks.adsenseDeleteMany.mockResolvedValue({ count: 0 });
    mocks.adManagerDeleteMany.mockResolvedValue({ count: 0 });
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
  it("valid → 200 with all three providers + batched insert of each fresh item (A-API-13)", async () => {
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ga4).toEqual(ga4Items);
    expect(body.searchConsole).toHaveLength(1);
    expect(body.adsense).toHaveLength(1);
    expect(body.errors).toBeUndefined();
    expect(mocks.getValidAccessToken).toHaveBeenCalledWith("conn1");
    // No previously discovered rows, so every item is fresh: one
    // createMany per provider, no per-row upsert at all.
    expect(mocks.googlePropertyCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.googlePropertyCreateMany).toHaveBeenCalledWith({
      data: [
        {
          connectionId: "conn1",
          propertyId: "properties/123",
          displayName: "Site GA4",
          accountId: "accounts/1",
        },
      ],
      skipDuplicates: true,
    });
    expect(mocks.scPropertyCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.adsenseCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.googlePropertyUpsert).not.toHaveBeenCalled();
    expect(mocks.scPropertyUpsert).not.toHaveBeenCalled();
    expect(mocks.adsenseUpsert).not.toHaveBeenCalled();
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

  it("Ad Manager enabled → networks listed, batched, returned (A-GGL-10, A-API-13)", async () => {
    mocks.adManagerEnabled.mockReturnValue(true);
    mocks.listAdManagerNetworks.mockResolvedValue([{ networkCode: "123456", displayName: "Network" }]);
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adManager).toEqual([{ networkCode: "123456", displayName: "Network" }]);
    expect(mocks.listAdManagerNetworks).toHaveBeenCalledTimes(1);
    // Fresh network: one createMany, no per-row upsert.
    expect(mocks.adManagerCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.adManagerCreateMany).toHaveBeenCalledWith({
      data: [{ connectionId: "conn1", networkCode: "123456", displayName: "Network" }],
      skipDuplicates: true,
    });
    expect(mocks.adManagerUpsert).not.toHaveBeenCalled();
  });

  it("Ad Manager disabled → never listed, no adManager key (A-GGL-10)", async () => {
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adManager).toBeUndefined();
    expect(mocks.listAdManagerNetworks).not.toHaveBeenCalled();
    expect(mocks.adManagerUpsert).not.toHaveBeenCalled();
  });

  it("Ad Manager failure → classified error, other providers unaffected, no prune (A-GGL-10)", async () => {
    mocks.adManagerEnabled.mockReturnValue(true);
    mocks.listAdManagerNetworks.mockRejectedValueOnce(new Error("boom"));
    mocks.adManagerFindMany.mockResolvedValue([{ id: "am-old", networkCode: "999" }]);
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adManager).toEqual([]);
    expect(body.errors).toMatchObject({ adManager: "provider_error" });
    expect(body.ga4).toHaveLength(1);
    expect(mocks.adManagerUpsert).not.toHaveBeenCalled();
    // The listing failed, so the fresh set is empty — pruning from it
    // would delete every network for the connection.
    expect(mocks.adManagerDeleteMany).not.toHaveBeenCalled();
  });

  it("stale rows are pruned, referenced rows are kept, pruned count is returned (A-GGL-10)", async () => {
    mocks.googlePropertyFindMany.mockResolvedValue([
      { id: "gp-old", propertyId: "properties/old" },
      { id: "gp-mapped", propertyId: "properties/mapped" },
      { id: "gp-123", propertyId: "properties/123" },
    ]);
    // Only the mapped row is referenced by an integration; the old row
    // is unreferenced and must go. gp-123 is in the fresh listing.
    mocks.integrationFindMany.mockImplementation(async ({ where }: { where: Record<string, { in: string[] }> }) => {
      const fk = Object.keys(where)[0]!;
      return where[fk]!.in.includes("gp-mapped") ? [{ [fk]: "gp-mapped" }] : [];
    });
    mocks.googlePropertyDeleteMany.mockResolvedValue({ count: 1 });
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    expect(mocks.googlePropertyDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["gp-old"] } } });
    expect(await res.json()).toMatchObject({ pruned: { ga4: 1 } });
  });

  it("prune is skipped on a truncated listing (A-GGL-10)", async () => {
    mocks.listGa4Properties.mockResolvedValueOnce({ items: ga4Items, truncated: true });
    mocks.googlePropertyFindMany.mockResolvedValue([{ id: "gp-old", propertyId: "properties/old" }]);
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ truncated: { ga4: true } });
    // The fresh set is partial — pruning from it would delete rows that
    // still exist at Google.
    expect(mocks.googlePropertyDeleteMany).not.toHaveBeenCalled();
  });

  it("prune is skipped when the provider listing fails (A-GGL-10)", async () => {
    mocks.listGa4Properties.mockRejectedValueOnce(new Error("boom"));
    mocks.googlePropertyFindMany.mockResolvedValue([{ id: "gp-old", propertyId: "properties/old" }]);
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    expect(mocks.googlePropertyDeleteMany).not.toHaveBeenCalled();
  });

  it("fresh rows go in one createMany, not one upsert per row (A-API-13)", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      propertyId: `properties/${i}`,
      displayName: `Site ${i}`,
      accountId: "accounts/1",
    }));
    mocks.listGa4Properties.mockResolvedValue({ items: many, truncated: false });
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    expect(mocks.googlePropertyCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.googlePropertyCreateMany).toHaveBeenCalledWith({
      data: many.map((p) => ({ connectionId: "conn1", ...p })),
      skipDuplicates: true,
    });
    expect(mocks.googlePropertyUpsert).not.toHaveBeenCalled();
  });

  it("already-known rows still upsert, in bounded chunks of 10 (A-GGL-10, A-API-13)", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      propertyId: `properties/${i}`,
      displayName: `Site ${i}`,
      accountId: "accounts/1",
    }));
    mocks.listGa4Properties.mockResolvedValue({ items: many, truncated: false });
    // Every discovered row already exists, so all 25 take the upsert
    // path (refreshing displayName) — none is fresh for createMany.
    mocks.googlePropertyFindMany.mockResolvedValue(
      many.map((p) => ({ id: `gp-${p.propertyId}`, propertyId: p.propertyId })),
    );
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.googlePropertyUpsert.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return {};
    });
    const res = await discoverPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    expect(mocks.googlePropertyCreateMany).not.toHaveBeenCalled();
    expect(mocks.googlePropertyUpsert).toHaveBeenCalledTimes(25);
    // Sequential upserts would peak at 1; unchunked Promise.all at 25.
    expect(maxInFlight).toBe(10);
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
  it("upsert writes exactly the provider's FK and NULLs the other three (A-DB-07)", async () => {
    const res = await mapPost(jsonReq(url, base));
    expect(res.status).toBe(200);
    const call = mocks.integrationUpsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    // The row must be CHECK-conformant by construction: the provider's FK
    // set, the other three NULL — so re-mapping a pre-CHECK legacy row
    // heals its stale FK instead of failing the CHECK.
    for (const data of [call.update, call.create]) {
      expect(data).toMatchObject({
        googleConnectionId: "conn1",
        googlePropertyId: "gp1",
        searchConsolePropertyId: null,
        adsenseAccountId: null,
        adManagerNetworkId: null,
      });
    }
  });
});

describe("POST /api/google/properties/map — A-DB-03 primary race (retry-once on P2002)", () => {
  const url = "http://localhost/api/google/properties/map";
  const p2002 = () =>
    Object.assign(new Error("Unique constraint failed on the fields: (`websiteId`,`provider`)"), { code: "P2002" });
  const primaryReq = (externalId: string) => ({
    websiteId: "w1",
    provider: "GA4",
    externalId,
    isPrimary: true,
  });
  // This block is a top-level sibling of the map describe, so it needs
  // its own copy of the map setup (the sibling's beforeEach does not run
  // here — relying on leaked implementations made the tests order-dependent).
  beforeEach(() => {
    mocks.googlePropertyFindMany.mockResolvedValue([{ id: "gp1", connectionId: "conn1" }]);
    mocks.connFindFirst.mockResolvedValue({ teamId: "t1", websiteId: null, ownerType: "TEAM", ownerId: "t1" });
    mocks.integrationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.websiteUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("first attempt collides on the partial unique index → retry succeeds → 200", async () => {
    mocks.integrationUpsert.mockRejectedValueOnce(p2002());
    const res = await mapPost(jsonReq(url, primaryReq("properties/123")));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ integration: { isPrimary: true } });
    // The whole transaction ran twice: demote + upsert in both attempts.
    expect(mocks.tx).toHaveBeenCalledTimes(2);
    expect(mocks.integrationUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("retry also collides → typed 409 primary_conflict, never a 500", async () => {
    mocks.integrationUpsert.mockRejectedValueOnce(p2002());
    mocks.integrationUpsert.mockRejectedValueOnce(p2002());
    const res = await mapPost(jsonReq(url, primaryReq("properties/123")));
    expect(res.status).toBe(409);
    // withApiErrors enriches error bodies with requestId (A-API-02), so
    // match the error code rather than the exact body.
    expect(await res.json()).toMatchObject({ error: "primary_conflict" });
    expect(mocks.tx).toHaveBeenCalledTimes(2);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("two concurrent primary maps for different properties → both 200, exactly one primary remains", async () => {
    // Tiny in-memory model of the single-primary invariant: demote clears
    // every primary for the website+provider, upsert sets the mapped row.
    // The first upsert across both requests throws P2002, modelling the
    // loser of the race; its retry demotes the winner and succeeds.
    const primaries = new Map<string, boolean>();
    let collided = false;
    mocks.tx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        websiteIntegration: {
          updateMany: async () => {
            for (const key of primaries.keys()) primaries.set(key, false);
            return { count: 1 };
          },
          upsert: async ({ create }: { create: { externalId: string; isPrimary: boolean } }) => {
            if (!collided) {
              collided = true;
              throw p2002();
            }
            primaries.set(create.externalId, create.isPrimary);
            return { id: `int-${create.externalId}`, ...create };
          },
        },
        website: { updateMany: mocks.websiteUpdateMany },
      }),
    );
    const [a, b] = await Promise.all([
      mapPost(jsonReq(url, primaryReq("properties/111"))),
      mapPost(jsonReq(url, primaryReq("properties/222"))),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([...primaries.values()].filter(Boolean)).toHaveLength(1);
  });
});
