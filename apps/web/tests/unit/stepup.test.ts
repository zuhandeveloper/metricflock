import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  assertConnectionVisible: vi.fn(),
  orgFindUnique: vi.fn(),
  orgGoogleConnections: vi.fn(),
  orgTxAuditDeleteMany: vi.fn(),
  orgTxOrgDelete: vi.fn(),
  revokeConnection: vi.fn(),
  apiKeyCreate: vi.fn(),
  apiKeyFindFirst: vi.fn(),
  apiKeyUpdate: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  googleConnectionCount: vi.fn(),
  websiteTransferCount: vi.fn(),
  connFindFirst: vi.fn(),
  invalidateOrgCache: vi.fn(),
  invalidateOrgSnapshots: vi.fn(),
  writeAudit: vi.fn(),
}));

// The auth module is mocked for the route wiring tests, but the real
// isSessionFresh / FRESH_SESSION_MAX_AGE_SECONDS are kept via
// importOriginal so the freshness rule itself is tested for real.
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    requireFreshSession: mocks.requireFreshSession,
    assertConnectionVisible: mocks.assertConnectionVisible,
  };
});
vi.mock("@metricflock/db", () => ({
  prisma: {
    organization: { findUnique: mocks.orgFindUnique },
    googleConnection: {
      findMany: mocks.orgGoogleConnections,
      count: mocks.googleConnectionCount,
      findFirst: mocks.connFindFirst,
    },
    apiKey: { create: mocks.apiKeyCreate, findFirst: mocks.apiKeyFindFirst, update: mocks.apiKeyUpdate },
    user: { findFirst: mocks.userFindFirst, update: mocks.userUpdate },
    websiteTransfer: { count: mocks.websiteTransferCount },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        auditLog: { deleteMany: mocks.orgTxAuditDeleteMany },
        organization: { delete: mocks.orgTxOrgDelete },
      }),
    ),
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/google/tokens", () => ({ revokeConnection: mocks.revokeConnection }));
vi.mock("@metricflock/db/snapshots", () => ({ invalidateOrgSnapshots: mocks.invalidateOrgSnapshots }));
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, invalidateOrgCache: mocks.invalidateOrgCache };
});

import { isSessionFresh, FRESH_SESSION_MAX_AGE_SECONDS } from "@metricflock/auth";
import { DELETE as deleteOrg } from "@/app/api/organization/route";
import { POST as mintApiKey } from "@/app/api/api-keys/route";
import { DELETE as revokeApiKey } from "@/app/api/api-keys/[id]/route";
import { DELETE as deleteMember, PATCH as patchMember } from "@/app/api/members/[id]/route";
import { POST as disconnect } from "@/app/api/google/connections/disconnect/route";
import { POST as completeTransfer } from "@/app/api/transfers/[id]/complete/route";

const authUser = { id: "u1", organizationId: "org-a", role: "SUPER_ADMIN" };
// Fresh instance per call: a NextResponse body can only be read once.
const staleError = () => ({
  error: new NextResponse(
    JSON.stringify({ error: "session_not_fresh", message: "Please sign in again to continue." }),
    { status: 401 },
  ),
});
const freshOk = { ok: true as const };

// A-SEC-02: destructive / privilege-minting routes require a fresh
// session (created within 15 min, matching better-auth freshAge).
// The predicate is tested for real below; the route tests prove the
// gate is installed on all seven routes and blocks before any mutation.
describe("isSessionFresh", () => {
  const now = new Date("2026-11-23T12:00:00Z");

  it("matches the configured 15-minute freshAge", () => {
    expect(FRESH_SESSION_MAX_AGE_SECONDS).toBe(60 * 15);
  });

  it("is fresh within the window", () => {
    expect(isSessionFresh(new Date(now.getTime() - 14 * 60 * 1000), now)).toBe(true);
    expect(isSessionFresh(new Date(now.getTime() - 60 * 1000), now)).toBe(true);
  });

  it("is stale at and past the boundary (better-auth: age >= freshAge is not fresh)", () => {
    expect(isSessionFresh(new Date(now.getTime() - 15 * 60 * 1000), now)).toBe(false);
    expect(isSessionFresh(new Date(now.getTime() - 16 * 60 * 1000), now)).toBe(false);
    expect(isSessionFresh(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), now)).toBe(false);
  });

  it("is never fresh without a parseable createdAt", () => {
    expect(isSessionFresh(null, now)).toBe(false);
    expect(isSessionFresh(undefined, now)).toBe(false);
    expect(isSessionFresh("not-a-date", now)).toBe(false);
  });

  it("accepts ISO strings as well as Dates", () => {
    expect(isSessionFresh(new Date(now.getTime() - 1000).toISOString(), now)).toBe(true);
  });
});

describe("step-up enforcement on destructive routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: authUser });
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.revokeConnection.mockResolvedValue(undefined);
    mocks.invalidateOrgCache.mockResolvedValue(undefined);
    mocks.invalidateOrgSnapshots.mockResolvedValue(undefined);
  });

  it("DELETE /api/organization: stale session → 401 session_not_fresh, nothing deleted", async () => {
    mocks.requireFreshSession.mockImplementation(() => Promise.resolve(staleError()));
    const res = await deleteOrg(
      new NextRequest("http://localhost/api/organization", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmSlug: "main-org" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("session_not_fresh");
    expect(mocks.orgFindUnique).not.toHaveBeenCalled();
  });

  it("DELETE /api/organization: fresh session → proceeds", async () => {
    mocks.requireFreshSession.mockResolvedValue(freshOk);
    mocks.orgFindUnique.mockResolvedValue({ id: "org-a", slug: "main-org", name: "Main" });
    mocks.orgGoogleConnections.mockResolvedValue([]);
    mocks.orgTxAuditDeleteMany.mockResolvedValue({ count: 0 });
    mocks.orgTxOrgDelete.mockResolvedValue({ id: "org-a" });
    const res = await deleteOrg(
      new NextRequest("http://localhost/api/organization", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmSlug: "main-org" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  it("POST /api/api-keys: stale session → 401, no key minted", async () => {
    mocks.requireFreshSession.mockImplementation(() => Promise.resolve(staleError()));
    const res = await mintApiKey(
      new NextRequest("http://localhost/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "stale-key" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("session_not_fresh");
    expect(mocks.apiKeyCreate).not.toHaveBeenCalled();
  });

  it("POST /api/api-keys: fresh session → mints the key", async () => {
    mocks.requireFreshSession.mockResolvedValue(freshOk);
    mocks.apiKeyCreate.mockResolvedValue({ id: "k1", name: "fresh-key", prefix: "mf_abc", createdAt: new Date() });
    const res = await mintApiKey(
      new NextRequest("http://localhost/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "fresh-key" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(mocks.apiKeyCreate).toHaveBeenCalledTimes(1);
  });

  it("DELETE /api/members/[id]: stale session → 401, member untouched", async () => {
    mocks.requireFreshSession.mockImplementation(() => Promise.resolve(staleError()));
    const res = await deleteMember(new NextRequest("http://localhost/api/members/u2", { method: "DELETE" }), {
      params: Promise.resolve({ id: "u2" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("session_not_fresh");
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
  });

  it("PATCH /api/members/[id]: stale session → 401, role unchanged", async () => {
    mocks.requireFreshSession.mockImplementation(() => Promise.resolve(staleError()));
    const res = await patchMember(
      new NextRequest("http://localhost/api/members/u2", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "TEAM_ADMIN" }),
      }),
      { params: Promise.resolve({ id: "u2" }) },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("session_not_fresh");
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
  });

  it("PATCH /api/members/[id]: fresh session → role change proceeds", async () => {
    mocks.requireFreshSession.mockResolvedValue(freshOk);
    mocks.userFindFirst.mockResolvedValue({ id: "u2", role: "TEAM_MEMBER", email: "m@example.com" });
    mocks.userUpdate.mockResolvedValue({ id: "u2", email: "m@example.com", role: "TEAM_ADMIN" });
    const res = await patchMember(
      new NextRequest("http://localhost/api/members/u2", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "TEAM_ADMIN" }),
      }),
      { params: Promise.resolve({ id: "u2" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ member: { id: "u2", email: "m@example.com", role: "TEAM_ADMIN" } });
  });

  it("DELETE /api/api-keys/[id]: stale session → 401, key not revoked", async () => {
    mocks.requireFreshSession.mockImplementation(() => Promise.resolve(staleError()));
    const res = await revokeApiKey(new NextRequest("http://localhost/api/api-keys/k1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "k1" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("session_not_fresh");
    expect(mocks.apiKeyFindFirst).not.toHaveBeenCalled();
  });

  it("DELETE /api/api-keys/[id]: fresh session → revokes the key", async () => {
    mocks.requireFreshSession.mockResolvedValue(freshOk);
    mocks.apiKeyFindFirst.mockResolvedValue({ id: "k1", revokedAt: null });
    mocks.apiKeyUpdate.mockResolvedValue({ id: "k1" });
    const res = await revokeApiKey(new NextRequest("http://localhost/api/api-keys/k1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "k1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.apiKeyUpdate).toHaveBeenCalledTimes(1);
  });

  it("POST /api/transfers/[id]/complete: stale session → 401, transfer untouched", async () => {
    mocks.requireFreshSession.mockImplementation(() => Promise.resolve(staleError()));
    const res = await completeTransfer(
      new NextRequest("http://localhost/api/transfers/t1/complete", { method: "POST" }),
      { params: Promise.resolve({ id: "t1" }) },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("session_not_fresh");
  });

  it("POST /api/google/connections/disconnect: stale session → 401, connection not revoked", async () => {
    mocks.requireFreshSession.mockImplementation(() => Promise.resolve(staleError()));
    const res = await disconnect(
      new NextRequest("http://localhost/api/google/connections/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: "conn-1" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("session_not_fresh");
    expect(mocks.revokeConnection).not.toHaveBeenCalled();
  });

  it("POST /api/google/connections/disconnect: fresh session → proceeds", async () => {
    mocks.requireFreshSession.mockResolvedValue(freshOk);
    mocks.connFindFirst.mockResolvedValue({ id: "conn-1", googleAccountEmail: "ga@example.com" });
    mocks.assertConnectionVisible.mockResolvedValue(undefined);
    const res = await disconnect(
      new NextRequest("http://localhost/api/google/connections/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: "conn-1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.revokeConnection).toHaveBeenCalledWith("conn-1");
  });
});
