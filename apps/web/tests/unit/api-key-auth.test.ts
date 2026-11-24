import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: { apiKey: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, rateLimit: mocks.rateLimit };
});

import { requireApiKey } from "@/lib/api-key-auth";
import { generateApiKey } from "@metricflock/shared";

const req = (auth?: string) =>
  new NextRequest("http://localhost/api/v1/websites", { headers: auth ? { authorization: auth } : {} });

describe("requireApiKey (Phase 7.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({});
    mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
  });

  it("rejects missing or malformed keys with 401", async () => {
    const noHeader = await requireApiKey(req());
    expect("error" in noHeader && noHeader.error.status).toBe(401);
    const bad = await requireApiKey(req("Bearer not-a-key"));
    expect("error" in bad && bad.error.status).toBe(401);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("rejects unknown and revoked keys with 401", async () => {
    const secret = generateApiKey();
    mocks.findUnique.mockResolvedValue(null);
    const unknown = await requireApiKey(req(`Bearer ${secret}`));
    expect("error" in unknown && unknown.error.status).toBe(401);

    mocks.findUnique.mockResolvedValue({ id: "k1", organizationId: "org1", createdById: "u1", revokedAt: new Date() });
    const revoked = await requireApiKey(req(`Bearer ${secret}`));
    expect("error" in revoked && revoked.error.status).toBe(401);
  });

  it("accepts a valid key, stamps lastUsedAt, and builds the org-scoped user", async () => {
    const secret = generateApiKey();
    mocks.findUnique.mockResolvedValue({ id: "k1", organizationId: "org1", createdById: "u1", revokedAt: null });
    const auth = await requireApiKey(req(`Bearer ${secret}`));
    expect("error" in auth).toBe(false);
    if (!("error" in auth)) {
      expect(auth.organizationId).toBe("org1");
      expect(auth.user).toEqual({ id: "u1", organizationId: "org1", role: "SUPER_ADMIN" });
      // Legacy key: no expiry/scopes stored → never expires, full access.
      expect(auth.expiresAt).toBeNull();
      expect(auth.scopes).toEqual([]);
    }
    expect(mocks.update).toHaveBeenCalled();
  });

  // A-SEC-09 — expiry and scope enforcement.
  it("rejects an expired key with 401", async () => {
    const secret = generateApiKey();
    mocks.findUnique.mockResolvedValue({
      id: "k1",
      organizationId: "org1",
      createdById: "u1",
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      scopes: [],
    });
    const auth = await requireApiKey(req(`Bearer ${secret}`));
    expect("error" in auth && auth.error.status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("accepts a key whose expiry is still in the future", async () => {
    const secret = generateApiKey();
    mocks.findUnique.mockResolvedValue({
      id: "k1",
      organizationId: "org1",
      createdById: "u1",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      scopes: [],
    });
    const auth = await requireApiKey(req(`Bearer ${secret}`));
    expect("error" in auth).toBe(false);
  });

  it("rejects a key without the route's required scope with 403", async () => {
    const secret = generateApiKey();
    mocks.findUnique.mockResolvedValue({
      id: "k1",
      organizationId: "org1",
      createdById: "u1",
      revokedAt: null,
      expiresAt: null,
      scopes: ["portfolio:read"],
    });
    const auth = await requireApiKey(req(`Bearer ${secret}`), "websites:read");
    expect("error" in auth && auth.error.status).toBe(403);
    if ("error" in auth) expect(await auth.error.json()).toMatchObject({ error: "insufficient_scope" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("accepts a key that carries the route's required scope", async () => {
    const secret = generateApiKey();
    mocks.findUnique.mockResolvedValue({
      id: "k1",
      organizationId: "org1",
      createdById: "u1",
      revokedAt: null,
      expiresAt: null,
      scopes: ["websites:read", "health:read"],
    });
    const auth = await requireApiKey(req(`Bearer ${secret}`), "websites:read");
    expect("error" in auth).toBe(false);
    if (!("error" in auth)) expect(auth.scopes).toEqual(["websites:read", "health:read"]);
  });

  it("a legacy key with no scopes stored passes any scope check", async () => {
    const secret = generateApiKey();
    // No expiresAt/scopes fields at all — the pre-A-SEC-09 shape.
    mocks.findUnique.mockResolvedValue({ id: "k1", organizationId: "org1", createdById: "u1", revokedAt: null });
    for (const scope of ["websites:read", "portfolio:read", "insights:read", "health:read"] as const) {
      const auth = await requireApiKey(req(`Bearer ${secret}`), scope);
      expect("error" in auth).toBe(false);
    }
  });

  it("returns 429 when the key is rate-limited", async () => {
    const secret = generateApiKey();
    mocks.findUnique.mockResolvedValue({ id: "k1", organizationId: "org1", createdById: "u1", revokedAt: null });
    mocks.rateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const auth = await requireApiKey(req(`Bearer ${secret}`));
    expect("error" in auth && auth.error.status).toBe(429);
  });
});
