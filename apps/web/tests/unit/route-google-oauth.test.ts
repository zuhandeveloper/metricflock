import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Coverage-gap closure: Google OAuth connect/callback, connections
// list, and disconnect (non-step-up paths; the step-up gate itself is
// covered in stepup.test.ts). Pattern follows
// routes-v1-analytics.test.ts — mocked Prisma + auth + Google clients.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  getSessionUser: vi.fn(),
  assertConnectionOwnerAccess: vi.fn(),
  assertConnectionVisible: vi.fn(),
  connectionVisibilityWhere: vi.fn(),
  writeAudit: vi.fn(),
  rateLimit: vi.fn(),
  connFindFirst: vi.fn(),
  connFindMany: vi.fn(),
  connCount: vi.fn(),
  connUpsert: vi.fn(),
  userFindUnique: vi.fn(),
  parseState: vi.fn(),
  consumeOAuthState: vi.fn(),
  getOAuthClient: vi.fn(),
  getGoogleAccountProfile: vi.fn(),
  buildAuthUrl: vi.fn(),
  providersMissingScopes: vi.fn(),
  adManagerEnabled: vi.fn(),
  revokeConnection: vi.fn(),
  invalidateOrgCache: vi.fn(),
  invalidateOrgSnapshots: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    googleConnection: {
      findFirst: mocks.connFindFirst,
      findMany: mocks.connFindMany,
      count: mocks.connCount,
      upsert: mocks.connUpsert,
    },
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/db/snapshots", () => ({ invalidateOrgSnapshots: mocks.invalidateOrgSnapshots }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    requireFreshSession: mocks.requireFreshSession,
    getSessionUser: mocks.getSessionUser,
    assertConnectionOwnerAccess: mocks.assertConnectionOwnerAccess,
    assertConnectionVisible: mocks.assertConnectionVisible,
    connectionVisibilityWhere: mocks.connectionVisibilityWhere,
  };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, rateLimit: mocks.rateLimit, invalidateOrgCache: mocks.invalidateOrgCache };
});
vi.mock("@metricflock/google/oauth", () => ({
  parseState: mocks.parseState,
  consumeOAuthState: mocks.consumeOAuthState,
  getOAuthClient: mocks.getOAuthClient,
  getGoogleAccountProfile: mocks.getGoogleAccountProfile,
  buildAuthUrl: mocks.buildAuthUrl,
  providersMissingScopes: mocks.providersMissingScopes,
  AD_MANAGER_SCOPES: ["https://www.googleapis.com/auth/admanager.readonly"],
}));
vi.mock("@metricflock/google/ad-manager", () => ({ adManagerEnabled: mocks.adManagerEnabled }));
vi.mock("@metricflock/google/tokens", () => ({ revokeConnection: mocks.revokeConnection }));

import { GET as connectGet } from "@/app/api/google/oauth/connect/route";
import { GET as callbackGet } from "@/app/api/google/oauth/callback/route";
import { GET as connectionsGet } from "@/app/api/google/connections/route";
import { POST as disconnectPost } from "@/app/api/google/connections/disconnect/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const unauth = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
const jsonReq = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const location = (res: Response) => res.headers.get("location") ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.requireFreshSession.mockResolvedValue({ ok: true as const });
  mocks.getSessionUser.mockResolvedValue(admin);
  mocks.assertConnectionOwnerAccess.mockResolvedValue({ id: "t1" });
  mocks.assertConnectionVisible.mockResolvedValue(undefined);
  mocks.connectionVisibilityWhere.mockResolvedValue({});
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  mocks.revokeConnection.mockResolvedValue(undefined);
  mocks.invalidateOrgCache.mockResolvedValue(undefined);
  mocks.invalidateOrgSnapshots.mockResolvedValue(undefined);
  mocks.adManagerEnabled.mockReturnValue(false);
  mocks.providersMissingScopes.mockReturnValue([]);
});

describe("GET /api/google/oauth/connect", () => {
  const url = "http://localhost/api/google/oauth/connect?ownerType=TEAM&ownerId=t1";
  it("unauthenticated → 401; rate-limited → 429; invalid query → 400; unknown owner → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await connectGet(new NextRequest(url))).status).toBe(401);
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const limited = await connectGet(new NextRequest(url));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    const bad = await connectGet(new NextRequest("http://localhost/api/google/oauth/connect?ownerType=BOGUS"));
    expect(bad.status).toBe(400);
    mocks.assertConnectionOwnerAccess.mockRejectedValueOnce(new Error("NOPE"));
    const missing = await connectGet(new NextRequest(url));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found_or_forbidden" });
  });
  it("valid → 307 redirect to Google's consent screen", async () => {
    mocks.buildAuthUrl.mockResolvedValue("https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
    const res = await connectGet(new NextRequest(url));
    expect(res.status).toBe(307);
    expect(location(res)).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=x");
    expect(mocks.buildAuthUrl).toHaveBeenCalledWith(admin, "TEAM", "t1", []);
  });
  it("Ad Manager enabled → its scope is requested too; build failure → 503", async () => {
    mocks.adManagerEnabled.mockReturnValue(true);
    mocks.buildAuthUrl.mockResolvedValue("https://accounts.google.com/o/oauth2/v2/auth?x=1");
    const res = await connectGet(new NextRequest(url));
    expect(res.status).toBe(307);
    expect(mocks.buildAuthUrl).toHaveBeenCalledWith(admin, "TEAM", "t1", [
      "https://www.googleapis.com/auth/admanager.readonly",
    ]);
    mocks.buildAuthUrl.mockRejectedValueOnce(new Error("not configured"));
    const failed = await connectGet(new NextRequest(url));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: "google_oauth_not_configured" });
  });
});

describe("GET /api/google/oauth/callback", () => {
  const base = "http://localhost/api/google/oauth/callback";
  const flow = { userId: "u1", organizationId: "org1", ownerType: "TEAM", ownerId: "t1", codeVerifier: "verifier" };
  beforeEach(() => {
    // encryptToken (real, from @metricflock/shared) needs a 32-byte key.
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    mocks.parseState.mockReturnValue({ nonce: "n1" });
    mocks.consumeOAuthState.mockResolvedValue(flow);
    mocks.getOAuthClient.mockReturnValue({
      getToken: vi.fn().mockResolvedValue({
        tokens: { refresh_token: "rt", access_token: "at", expiry_date: Date.now() + 3600_000, scope: "openid email" },
      }),
      setCredentials: vi.fn(),
    });
    mocks.getGoogleAccountProfile.mockResolvedValue({ id: "google-1", email: "ga@example.com" });
    mocks.userFindUnique.mockResolvedValue({ id: "u1", organizationId: "org1" });
    mocks.connUpsert.mockResolvedValue({ id: "conn1" });
  });

  it("provider error / missing params → redirect with oauth=denied|invalid", async () => {
    expect(location(await callbackGet(new NextRequest(`${base}?error=access_denied`)))).toContain("oauth=denied");
    expect(location(await callbackGet(new NextRequest(base)))).toContain("oauth=invalid");
  });
  it("rate-limited → oauth=rate_limited; bad state → oauth=bad_state", async () => {
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=rate_limited");
    mocks.parseState.mockImplementationOnce(() => {
      throw new Error("bad");
    });
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=bad_state");
    mocks.consumeOAuthState.mockResolvedValueOnce(null);
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=bad_state");
  });
  it("no session → oauth=login_required; wrong session → oauth=session_mismatch", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=login_required");
    mocks.getSessionUser.mockResolvedValueOnce({ ...admin, id: "u2" });
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=session_mismatch");
  });
  it("no refresh token → oauth=no_refresh_token; token exchange failure → oauth=failed", async () => {
    mocks.getOAuthClient.mockReturnValueOnce({
      getToken: vi.fn().mockResolvedValue({ tokens: { access_token: "at" } }),
      setCredentials: vi.fn(),
    });
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=no_refresh_token");
    mocks.getOAuthClient.mockReturnValueOnce({
      getToken: vi.fn().mockRejectedValue(new Error("exchange failed")),
      setCredentials: vi.fn(),
    });
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=failed");
  });
  it("user gone → oauth=user_not_found; org moved → oauth=org_mismatch; owner revoked → oauth=forbidden", async () => {
    mocks.userFindUnique.mockResolvedValueOnce(null);
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=user_not_found");
    mocks.userFindUnique.mockResolvedValueOnce({ id: "u1", organizationId: "org2" });
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=org_mismatch");
    mocks.assertConnectionOwnerAccess.mockRejectedValueOnce(new Error("NOPE"));
    expect(location(await callbackGet(new NextRequest(`${base}?code=c&state=s`)))).toContain("oauth=forbidden");
  });
  it("valid → upserts the connection, audits, invalidates, redirects oauth=connected", async () => {
    const res = await callbackGet(new NextRequest(`${base}?code=c&state=s`));
    expect(res.status).toBe(307);
    expect(location(res)).toContain("oauth=connected");
    expect(mocks.consumeOAuthState).toHaveBeenCalledWith("n1");
    expect(mocks.connUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId_ownerType_ownerId_googleAccountEmail: expect.objectContaining({
            organizationId: "org1",
            googleAccountEmail: "ga@example.com",
          }),
        }),
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "google.connection.created", entityType: "GoogleConnection" }),
    );
    expect(mocks.invalidateOrgCache).toHaveBeenCalledWith("org1");
    expect(mocks.invalidateOrgSnapshots).toHaveBeenCalledWith("org1");
  });
});

describe("GET /api/google/connections", () => {
  const url = "http://localhost/api/google/connections";
  const connRow = {
    id: "conn1",
    ownerType: "TEAM",
    ownerId: "t1",
    teamId: "t1",
    websiteId: null,
    googleAccountEmail: "ga@example.com",
    scopes: ["openid"],
    status: "ACTIVE",
    lastUsedAt: new Date(),
    lastSuccessfulAuthAt: new Date(),
    createdAt: new Date(),
  };
  it("unauthenticated → 401; valid → 200 list with reauth flags + pagination", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await connectionsGet(new NextRequest(url))).status).toBe(401);
    mocks.connFindMany.mockResolvedValue([connRow]);
    mocks.connCount.mockResolvedValue(1);
    const res = await connectionsGet(new NextRequest(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connections[0]).toMatchObject({ id: "conn1", missingProviders: [], needsReauth: false });
    expect(body.pagination).toMatchObject({ total: 1 });
    expect(mocks.connectionVisibilityWhere).toHaveBeenCalledWith(admin);
    expect(mocks.connFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org1" } }));
  });
  it("missing scopes → needsReauth with the missing providers", async () => {
    mocks.connFindMany.mockResolvedValue([connRow]);
    mocks.connCount.mockResolvedValue(1);
    mocks.providersMissingScopes.mockReturnValue(["AD_MANAGER"]);
    const res = await connectionsGet(new NextRequest(url));
    const body = await res.json();
    expect(body.connections[0]).toMatchObject({ missingProviders: ["AD_MANAGER"], needsReauth: true });
    expect(mocks.providersMissingScopes).toHaveBeenCalledWith(["openid"], { adManagerEnabled: false });
  });
});

describe("POST /api/google/connections/disconnect", () => {
  const url = "http://localhost/api/google/connections/disconnect";
  it("unauthenticated → 401; invalid input → 400; unknown connection → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await disconnectPost(jsonReq(url, { connectionId: "conn1" }))).status).toBe(401);
    expect((await disconnectPost(jsonReq(url, {}))).status).toBe(400);
    mocks.connFindFirst.mockResolvedValue(null);
    const missing = await disconnectPost(jsonReq(url, { connectionId: "conn9" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
  });
  it("invisible connection → 404; valid → 200 + revoke + audit + invalidates", async () => {
    mocks.connFindFirst.mockResolvedValue({ id: "conn1", googleAccountEmail: "ga@example.com" });
    mocks.assertConnectionVisible.mockRejectedValueOnce(new Error("NOPE"));
    const hidden = await disconnectPost(jsonReq(url, { connectionId: "conn1" }));
    expect(hidden.status).toBe(404);
    // A-GGL-06: the disconnect unmaps the connection's MAPPED
    // integrations; the count is audited on the disconnect event.
    mocks.revokeConnection.mockResolvedValue(2);
    const res = await disconnectPost(jsonReq(url, { connectionId: "conn1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.revokeConnection).toHaveBeenCalledWith("conn1");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "google.connection.disconnected",
        entityType: "GoogleConnection",
        entityId: "conn1",
        details: expect.objectContaining({ googleAccountEmail: "ga@example.com", unmappedIntegrations: 2 }),
      }),
    );
    expect(mocks.invalidateOrgCache).toHaveBeenCalledWith("org1");
    expect(mocks.invalidateOrgSnapshots).toHaveBeenCalledWith("org1");
  });
});
