import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  userFindFirst: vi.fn(),
  rootUserCount: vi.fn(),
  rootUserDelete: vi.fn(),
  rootUserUpdate: vi.fn(),
  googleConnectionCount: vi.fn(),
  websiteTransferCount: vi.fn(),
  txQueryRaw: vi.fn(),
  txCount: vi.fn(),
  txDelete: vi.fn(),
  txUpdate: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@metricflock/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireFreshSession: mocks.requireFreshSession,
}));
vi.mock("@metricflock/db", () => ({
  prisma: {
    user: {
      findFirst: mocks.userFindFirst,
      count: mocks.rootUserCount,
      delete: mocks.rootUserDelete,
      update: mocks.rootUserUpdate,
    },
    googleConnection: { count: mocks.googleConnectionCount },
    websiteTransfer: { count: mocks.websiteTransferCount },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));

import { PATCH, DELETE } from "@/app/api/members/[id]/route";

const authUser = { id: "u-admin", organizationId: "org-a", role: "SUPER_ADMIN" };
const ctx = { params: Promise.resolve({ id: "u2" }) };
const tx = {
  $queryRaw: mocks.txQueryRaw,
  user: { count: mocks.txCount, delete: mocks.txDelete, update: mocks.txUpdate },
};
const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/members/u2", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// A-DB-02: the last-SUPER_ADMIN count + delete/demote must happen
// atomically — inside one transaction with the admin rows locked
// (SELECT … FOR UPDATE) — so two concurrent deletes of the last two
// admins cannot both observe count 2 and both proceed. With mocked
// Prisma the test proves the count and the mutation both run on the
// transaction client, behind the row lock, and that the last admin is
// refused. True concurrency against a real DB is CI-smoke territory —
// mocks cannot prove two transactions serialize.
describe("DELETE /api/members/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: authUser });
    mocks.requireFreshSession.mockResolvedValue({ ok: true });
    mocks.googleConnectionCount.mockResolvedValue(0);
    mocks.websiteTransferCount.mockResolvedValue(0);
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
  });

  it("refuses to delete the last SUPER_ADMIN (count 1 inside the transaction)", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", role: "SUPER_ADMIN", email: "last@example.com" });
    mocks.txCount.mockResolvedValue(1);
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "last_super_admin", requestId: expect.any(String) });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.txQueryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.txCount).toHaveBeenCalledWith({
      where: { organizationId: "org-a", role: "SUPER_ADMIN" },
    });
    expect(mocks.txDelete).not.toHaveBeenCalled();
    expect(mocks.rootUserDelete).not.toHaveBeenCalled();
    expect(mocks.rootUserCount).not.toHaveBeenCalled();
  });

  it("deletes a SUPER_ADMIN when another remains, locking the admin rows first", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", role: "SUPER_ADMIN", email: "a@example.com" });
    mocks.txCount.mockResolvedValue(2);
    mocks.txDelete.mockResolvedValue({ id: "u2" });
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(mocks.txDelete).toHaveBeenCalledWith({ where: { id: "u2" } });
    // The lock is taken before the count is read.
    expect(mocks.txQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.txCount.mock.invocationCallOrder[0]);
  });

  it("deletes a non-admin without taking the admin lock", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", role: "TEAM_MEMBER", email: "m@example.com" });
    mocks.txDelete.mockResolvedValue({ id: "u2" });
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(mocks.txQueryRaw).not.toHaveBeenCalled();
    expect(mocks.txDelete).toHaveBeenCalledWith({ where: { id: "u2" } });
  });

  it("still returns 200 when the audit write fails (audit must not mask a committed delete)", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", role: "TEAM_MEMBER", email: "m@example.com" });
    mocks.txDelete.mockResolvedValue({ id: "u2" });
    mocks.writeAudit.mockRejectedValue(new Error("audit down"));
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/members/[id] (demote)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: authUser });
    mocks.requireFreshSession.mockResolvedValue({ ok: true });
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
  });

  it("refuses to demote the last SUPER_ADMIN (count + update inside the transaction)", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", role: "SUPER_ADMIN", email: "last@example.com" });
    mocks.txCount.mockResolvedValue(1);
    const res = await PATCH(req("PATCH", { role: "TEAM_MEMBER" }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "last_super_admin", requestId: expect.any(String) });
    expect(mocks.txQueryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.txUpdate).not.toHaveBeenCalled();
    expect(mocks.rootUserUpdate).not.toHaveBeenCalled();
  });

  it("demotes a SUPER_ADMIN when another remains", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", role: "SUPER_ADMIN", email: "a@example.com" });
    mocks.txCount.mockResolvedValue(2);
    mocks.txUpdate.mockResolvedValue({ id: "u2", email: "a@example.com", role: "TEAM_MEMBER" });
    const res = await PATCH(req("PATCH", { role: "TEAM_MEMBER" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).member.role).toBe("TEAM_MEMBER");
    expect(mocks.txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u2" }, data: { role: "TEAM_MEMBER" } }),
    );
  });

  it("promotes a non-admin without the transaction (no last-admin risk)", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", role: "TEAM_MEMBER", email: "m@example.com" });
    mocks.rootUserUpdate.mockResolvedValue({ id: "u2", email: "m@example.com", role: "TEAM_ADMIN" });
    const res = await PATCH(req("PATCH", { role: "TEAM_ADMIN" }), ctx);
    expect(res.status).toBe(200);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.rootUserUpdate).toHaveBeenCalled();
  });
});
