import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// A-GGL-18: getGoogleAccountProfile used to fall back to a fake
// "unknown@google" email when userinfo returned none. The callback
// upserts connections on (organizationId, ownerType, ownerId,
// googleAccountEmail), so two different Google accounts with no email
// in userinfo would collide on the same unknown@google row and the
// second connect would silently overwrite the first account's tokens.
// The fix throws in getGoogleAccountProfile; the callback's profile
// stage (A-GGL-17) then redirects oauth=profile_failed and stores
// nothing. This file keeps the REAL getGoogleAccountProfile and stubs
// only the googleapis userinfo call (pattern: google-oauth.test.ts)
// plus the callback's other deps (pattern: route-google-oauth.test.ts).
const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  assertConnectionOwnerAccess: vi.fn(),
  writeAudit: vi.fn(),
  rateLimit: vi.fn(),
  connUpsert: vi.fn(),
  userFindUnique: vi.fn(),
  parseState: vi.fn(),
  consumeOAuthState: vi.fn(),
  getOAuthClient: vi.fn(),
  userinfoGet: vi.fn(),
  invalidateOrgCache: vi.fn(),
  invalidateOrgSnapshots: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    googleConnection: { upsert: mocks.connUpsert },
    user: { findUnique: mocks.userFindUnique },
    // oauth.ts imports prisma at module scope; the real
    // consumeOAuthState is stubbed below, so these are never called.
    oAuthState: { deleteMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/db/snapshots", () => ({ invalidateOrgSnapshots: mocks.invalidateOrgSnapshots }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    getSessionUser: mocks.getSessionUser,
    assertConnectionOwnerAccess: mocks.assertConnectionOwnerAccess,
  };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, rateLimit: mocks.rateLimit, invalidateOrgCache: mocks.invalidateOrgCache };
});
vi.mock("googleapis", async (importOriginal) => {
  // googleapis is @metricflock/google's dependency, not the web app's,
  // so its types are not resolvable from here — treat it structurally.
  const actual = (await importOriginal()) as { google: Record<string, unknown> };
  return {
    ...actual,
    google: {
      ...actual.google,
      oauth2: () => ({ userinfo: { get: mocks.userinfoGet } }),
    },
  };
});
vi.mock("@metricflock/google/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/google/oauth")>();
  return {
    ...actual,
    parseState: mocks.parseState,
    consumeOAuthState: mocks.consumeOAuthState,
    getOAuthClient: mocks.getOAuthClient,
    // getGoogleAccountProfile stays REAL — it is the A-GGL-18 fix site.
  };
});

import { GET as callbackGet } from "@/app/api/google/oauth/callback/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const location = (res: Response) => res.headers.get("location") ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  // encryptToken (real, from @metricflock/shared) needs a 32-byte key.
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  mocks.getSessionUser.mockResolvedValue(admin);
  mocks.assertConnectionOwnerAccess.mockResolvedValue({ id: "t1" });
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  mocks.invalidateOrgCache.mockResolvedValue(undefined);
  mocks.invalidateOrgSnapshots.mockResolvedValue(undefined);
  mocks.parseState.mockReturnValue({ nonce: "n1" });
  mocks.consumeOAuthState.mockResolvedValue({
    userId: "u1",
    organizationId: "org1",
    ownerType: "TEAM",
    ownerId: "t1",
    codeVerifier: "verifier",
  });
  mocks.getOAuthClient.mockReturnValue({
    getToken: vi.fn().mockResolvedValue({
      tokens: { refresh_token: "rt", access_token: "at", expiry_date: Date.now() + 3600_000, scope: "openid email" },
    }),
    setCredentials: vi.fn(),
  });
  mocks.userFindUnique.mockResolvedValue({ id: "u1", organizationId: "org1" });
  mocks.connUpsert.mockResolvedValue({ id: "conn1" });
});

describe("GET /api/google/oauth/callback — profile email (A-GGL-18)", () => {
  const base = "http://localhost/api/google/oauth/callback";

  it("userinfo with no email → oauth=profile_failed, no connection row created (A-GGL-18)", async () => {
    mocks.userinfoGet.mockResolvedValue({ data: { id: "google-1" } });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await callbackGet(new NextRequest(`${base}?code=c&state=s`));
    expect(location(res)).toContain("oauth=profile_failed");
    expect(mocks.connUpsert).not.toHaveBeenCalled();
    // A-GGL-17: the failure is logged server-side with the classified stage.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"msg":"google oauth callback failed"'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('"stage":"profile"'));
    errSpy.mockRestore();
  });

  it("userinfo with an empty email → oauth=profile_failed, no connection row created (A-GGL-18)", async () => {
    mocks.userinfoGet.mockResolvedValue({ data: { id: "google-1", email: "" } });
    const res = await callbackGet(new NextRequest(`${base}?code=c&state=s`));
    expect(location(res)).toContain("oauth=profile_failed");
    expect(mocks.connUpsert).not.toHaveBeenCalled();
  });

  it("userinfo with an email → oauth=connected, connection upserted under that email (control)", async () => {
    mocks.userinfoGet.mockResolvedValue({ data: { id: "google-1", email: "ga@example.com" } });
    const res = await callbackGet(new NextRequest(`${base}?code=c&state=s`));
    expect(location(res)).toContain("oauth=connected");
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
  });
});
