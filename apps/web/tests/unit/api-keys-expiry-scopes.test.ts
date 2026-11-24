import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// A-SEC-09 — API key expiry + scopes: mint validation, list fields,
// and the rotation endpoint. Pattern follows
// route-members-reports-sync.test.ts (mocked Prisma + auth).
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  writeAudit: vi.fn(),
  apiKeyFindMany: vi.fn(),
  apiKeyFindFirst: vi.fn(),
  apiKeyCreate: vi.fn(),
  apiKeyUpdate: vi.fn(),
  tx: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    apiKey: {
      findMany: mocks.apiKeyFindMany,
      findFirst: mocks.apiKeyFindFirst,
      create: mocks.apiKeyCreate,
      update: mocks.apiKeyUpdate,
    },
    $transaction: mocks.tx,
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return { ...actual, requireApiAuth: mocks.requireApiAuth, requireFreshSession: mocks.requireFreshSession };
});

import { GET as apiKeysGet, POST as apiKeysPost } from "@/app/api/api-keys/route";
import { POST as rotateApiKey } from "@/app/api/api-keys/[id]/rotate/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const unauth = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const FUTURE_EXPIRY = "2027-05-24T10:00:00.000Z"; // ~6 months out, inside the 1-year cap
const TOO_FAR_EXPIRY = "2028-01-01T00:00:00.000Z"; // >1 year out

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.requireFreshSession.mockResolvedValue({ ok: true as const });
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.apiKeyCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "k2",
    ...data,
    createdAt: new Date("2026-11-24T10:00:00.000Z"),
  }));
  mocks.tx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ apiKey: { update: mocks.apiKeyUpdate, create: mocks.apiKeyCreate } }),
  );
});

describe("GET /api/api-keys (A-SEC-09)", () => {
  it("returns expiresAt and scopes for each key", async () => {
    mocks.apiKeyFindMany.mockResolvedValue([
      {
        id: "k1",
        name: "CI",
        prefix: "mf_abc",
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: new Date(FUTURE_EXPIRY),
        scopes: ["websites:read"],
        createdAt: new Date("2026-11-20T10:00:00.000Z"),
      },
    ]);
    const res = await apiKeysGet(new NextRequest("http://localhost/api/api-keys"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys[0]).toMatchObject({ id: "k1", scopes: ["websites:read"] });
    expect(body.keys[0].expiresAt).toBe(new Date(FUTURE_EXPIRY).toISOString());
  });
});

describe("POST /api/api-keys (A-SEC-09)", () => {
  const url = "http://localhost/api/api-keys";

  it("rejects a past or too-far expiry with 400 invalid_expires_at", async () => {
    for (const expiresAt of ["2020-01-01T00:00:00.000Z", TOO_FAR_EXPIRY, "not-a-date"]) {
      const res = await apiKeysPost(jsonReq(url, "POST", { name: "CI", expiresAt }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_expires_at" });
    }
    expect(mocks.apiKeyCreate).not.toHaveBeenCalled();
  });

  it("rejects unknown scopes with 400 invalid_scopes", async () => {
    for (const scopes of [["admin:write"], ["websites:read", "org:delete"], "websites:read", [42]]) {
      const res = await apiKeysPost(jsonReq(url, "POST", { name: "CI", scopes }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_scopes" });
    }
    expect(mocks.apiKeyCreate).not.toHaveBeenCalled();
  });

  it("mints with expiry + scopes, stores them, and audits them", async () => {
    const res = await apiKeysPost(
      jsonReq(url, "POST", { name: "CI", expiresAt: FUTURE_EXPIRY, scopes: ["websites:read"] }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatchObject({ id: "k2", name: "CI", scopes: ["websites:read"] });
    expect(body.key.expiresAt).toBe(new Date(FUTURE_EXPIRY).toISOString());
    expect(body.secret.startsWith("mf_")).toBe(true);
    expect(mocks.apiKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "CI",
          expiresAt: new Date(FUTURE_EXPIRY),
          scopes: ["websites:read"],
        }),
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.created",
        details: expect.objectContaining({ scopes: ["websites:read"] }),
      }),
    );
  });

  it("omitting expiry/scopes mints a legacy key (null expiry, full access)", async () => {
    const res = await apiKeysPost(jsonReq(url, "POST", { name: "CI" }));
    expect(res.status).toBe(201);
    expect(mocks.apiKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expiresAt: null, scopes: [] }) }),
    );
  });

  it("unauthenticated → 401, no key minted", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect(await apiKeysPost(jsonReq(url, "POST", { name: "CI" }))).toHaveProperty("status", 401);
    expect(mocks.apiKeyCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/api-keys/[id]/rotate (A-SEC-09)", () => {
  const url = (id: string) => `http://localhost/api/api-keys/${id}/rotate`;
  const oldKey = {
    id: "k1",
    name: "CI",
    scopes: ["websites:read"],
    expiresAt: new Date(FUTURE_EXPIRY),
    revokedAt: null,
  };

  it("unknown or revoked key → 404 api_key_not_found", async () => {
    mocks.apiKeyFindFirst.mockResolvedValue(null);
    const missing = await rotateApiKey(new NextRequest(url("k9"), { method: "POST" }), ctx("k9"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "api_key_not_found" });

    mocks.apiKeyFindFirst.mockResolvedValue({ ...oldKey, revokedAt: new Date() });
    const revoked = await rotateApiKey(new NextRequest(url("k1"), { method: "POST" }), ctx("k1"));
    expect(revoked.status).toBe(404);
    expect(mocks.apiKeyUpdate).not.toHaveBeenCalled();
    expect(mocks.apiKeyCreate).not.toHaveBeenCalled();
  });

  it("expired key → 400 key_expired (rotate cannot extend a dead key)", async () => {
    mocks.apiKeyFindFirst.mockResolvedValue({ ...oldKey, expiresAt: new Date("2020-01-01T00:00:00.000Z") });
    const res = await rotateApiKey(new NextRequest(url("k1"), { method: "POST" }), ctx("k1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "key_expired" });
    expect(mocks.apiKeyCreate).not.toHaveBeenCalled();
  });

  it("invalid replacement expiry → 400 invalid_expires_at", async () => {
    mocks.apiKeyFindFirst.mockResolvedValue(oldKey);
    const res = await rotateApiKey(jsonReq(url("k1"), "POST", { expiresAt: TOO_FAR_EXPIRY }), ctx("k1"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_expires_at" });
    expect(mocks.apiKeyCreate).not.toHaveBeenCalled();
  });

  it("rotates atomically: old key revoked, new key inherits name/scopes/expiry", async () => {
    mocks.apiKeyFindFirst.mockResolvedValue(oldKey);
    mocks.apiKeyUpdate.mockResolvedValue({ id: "k1" });
    const res = await rotateApiKey(new NextRequest(url("k1"), { method: "POST" }), ctx("k1"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatchObject({ name: "CI", scopes: ["websites:read"] });
    expect(body.key.expiresAt).toBe(new Date(FUTURE_EXPIRY).toISOString());
    expect(body.key.id).not.toBe("k1");
    expect(typeof body.secret).toBe("string");
    expect(body.secret.startsWith("mf_")).toBe(true);
    expect(mocks.tx).toHaveBeenCalledTimes(1);
    expect(mocks.apiKeyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "k1" }, data: expect.objectContaining({ revokedAt: expect.any(Date) }) }),
    );
    expect(mocks.apiKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "CI",
          scopes: ["websites:read"],
          expiresAt: new Date(FUTURE_EXPIRY),
        }),
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "api_key.rotated", details: expect.objectContaining({ rotatedFrom: "k1" }) }),
    );
  });

  it("an explicit expiresAt overrides the inherited expiry", async () => {
    mocks.apiKeyFindFirst.mockResolvedValue(oldKey);
    const res = await rotateApiKey(jsonReq(url("k1"), "POST", { expiresAt: "2027-02-22T10:00:00.000Z" }), ctx("k1"));
    expect(res.status).toBe(201);
    expect(mocks.apiKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expiresAt: new Date("2027-02-22T10:00:00.000Z") }) }),
    );
  });

  it("stale session → 401, nothing rotated", async () => {
    mocks.requireFreshSession.mockResolvedValueOnce({
      error: NextResponse.json({ error: "session_not_fresh" }, { status: 401 }),
    });
    const res = await rotateApiKey(new NextRequest(url("k1"), { method: "POST" }), ctx("k1"));
    expect(res.status).toBe(401);
    expect(mocks.apiKeyFindFirst).not.toHaveBeenCalled();
  });
});
