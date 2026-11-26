import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Platform-admin role change (PATCH /api/admin/users/[id]): only the
// first registered user on the platform may call it, and the
// last-SUPER_ADMIN guard applies to the TARGET's organization — the
// actor acts across organizations, so the actor's own org is
// irrelevant to the guard and to the audit row.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  isPlatformAdmin: vi.fn(),
  userFindFirst: vi.fn(),
  rootUserUpdate: vi.fn(),
  txQueryRaw: vi.fn(),
  txCount: vi.fn(),
  txUpdate: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@metricflock/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireFreshSession: mocks.requireFreshSession,
  isPlatformAdmin: mocks.isPlatformAdmin,
}));
vi.mock("@metricflock/db", () => ({
  prisma: {
    user: {
      findFirst: mocks.userFindFirst,
      update: mocks.rootUserUpdate,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));

import { PATCH } from "@/app/api/admin/users/[id]/route";

const platformAdmin = { id: "u-platform", organizationId: "org-a", role: "SUPER_ADMIN" };
const ctx = { params: Promise.resolve({ id: "u2" }) };
const tx = {
  $queryRaw: mocks.txQueryRaw,
  user: { count: mocks.txCount, update: mocks.txUpdate },
};
const req = (body?: unknown) =>
  new NextRequest("http://localhost/api/admin/users/u2", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("PATCH /api/admin/users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: platformAdmin });
    mocks.requireFreshSession.mockResolvedValue({ ok: true });
    mocks.isPlatformAdmin.mockResolvedValue(true);
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
  });

  it("refuses non-platform-admin actors with 403 before any lookup", async () => {
    mocks.isPlatformAdmin.mockResolvedValue(false);
    const res = await PATCH(req({ role: "TEAM_ADMIN" }), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect(mocks.isPlatformAdmin).toHaveBeenCalledWith("u-platform");
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
    expect(mocks.rootUserUpdate).not.toHaveBeenCalled();
  });

  it("rejects a stale session (step-up auth)", async () => {
    const { NextResponse } = await import("next/server");
    mocks.requireFreshSession.mockResolvedValue({
      error: NextResponse.json({ error: "session_not_fresh" }, { status: 401 }),
    });
    const res = await PATCH(req({ role: "TEAM_ADMIN" }), ctx);
    expect(res.status).toBe(401);
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown target", async () => {
    mocks.userFindFirst.mockResolvedValue(null);
    const res = await PATCH(req({ role: "TEAM_ADMIN" }), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    // Platform-wide lookup: NOT scoped to the actor's organization.
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      where: { id: "u2" },
      select: { id: true, role: true, email: true, organizationId: true },
    });
  });

  it("refuses to change the platform admin's own role", async () => {
    mocks.userFindFirst.mockResolvedValue({
      id: "u-platform",
      role: "SUPER_ADMIN",
      email: "root@example.com",
      organizationId: "org-a",
    });
    const res = await PATCH(req({ role: "TEAM_MEMBER" }), { params: Promise.resolve({ id: "u-platform" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "cannot_change_own_role" });
    expect(mocks.rootUserUpdate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid role body", async () => {
    const res = await PATCH(req({ role: "OWNER" }), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
  });

  it("promotes a user in another organization and audits against the target's org", async () => {
    mocks.userFindFirst.mockResolvedValue({
      id: "u2",
      role: "TEAM_MEMBER",
      email: "m@example.com",
      organizationId: "org-b",
    });
    mocks.rootUserUpdate.mockResolvedValue({ id: "u2", email: "m@example.com", role: "TEAM_ADMIN" });
    const res = await PATCH(req({ role: "TEAM_ADMIN" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).member.role).toBe("TEAM_ADMIN");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.rootUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u2" }, data: { role: "TEAM_ADMIN" } }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-b",
        actorId: "u-platform",
        action: "member.role_changed",
        entityType: "User",
        entityId: "u2",
        details: { email: "m@example.com", from: "TEAM_MEMBER", to: "TEAM_ADMIN" },
      }),
    );
  });

  it("refuses to demote the last SUPER_ADMIN of the target's organization", async () => {
    mocks.userFindFirst.mockResolvedValue({
      id: "u2",
      role: "SUPER_ADMIN",
      email: "last@example.com",
      organizationId: "org-b",
    });
    mocks.txCount.mockResolvedValue(1);
    const res = await PATCH(req({ role: "TEAM_MEMBER" }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "last_super_admin" });
    expect(mocks.txQueryRaw).toHaveBeenCalledTimes(1);
    // The guard counts admins in the TARGET's org, not the actor's.
    expect(mocks.txCount).toHaveBeenCalledWith({
      where: { organizationId: "org-b", role: "SUPER_ADMIN" },
    });
    expect(mocks.txUpdate).not.toHaveBeenCalled();
    expect(mocks.rootUserUpdate).not.toHaveBeenCalled();
  });

  it("demotes a SUPER_ADMIN when another remains in the target's org, audit inside the transaction", async () => {
    mocks.userFindFirst.mockResolvedValue({
      id: "u2",
      role: "SUPER_ADMIN",
      email: "a@example.com",
      organizationId: "org-b",
    });
    mocks.txCount.mockResolvedValue(2);
    mocks.txUpdate.mockResolvedValue({ id: "u2", email: "a@example.com", role: "TEAM_MEMBER" });
    const res = await PATCH(req({ role: "TEAM_MEMBER" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).member.role).toBe("TEAM_MEMBER");
    expect(mocks.txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u2" }, data: { role: "TEAM_MEMBER" } }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-b", action: "member.role_changed" }),
      tx,
    );
  });
});
