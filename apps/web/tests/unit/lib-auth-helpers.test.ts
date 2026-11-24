import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Coverage-gap closure: packages/auth/src/api-helpers.ts (requireApiAuth,
// requireFreshSession, apiError) + packages/auth/src/server.ts helpers
// (getSessionUser, getSession, requireAuth, destroySession) and the
// better-auth databaseHooks (sign-up org assignment, invite consumption,
// auth-event audit, update guard), reached through auth.options — the
// hooks are plain functions on the better-auth instance, so they can be
// invoked directly with a mocked Prisma client.
const mocks = vi.hoisted(() => ({
  writeAudit: vi.fn(),
  userFindUnique: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteUpdateMany: vi.fn(),
  orgCreate: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@metricflock/db", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    organizationInvite: { findFirst: mocks.inviteFindFirst, updateMany: mocks.inviteUpdateMany },
    organization: { create: mocks.orgCreate },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  auth,
  SESSION_COOKIE,
  getSessionUser,
  getSession,
  requireAuth,
  destroySession,
  requireApiAuth,
  requireFreshSession,
  apiError,
} from "@metricflock/auth";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const member = { id: "u2", organizationId: "org1", role: "TEAM_MEMBER", email: "m@example.com" };

type Hooks = {
  session: { create: { after: (session: { userId: string; ipAddress?: string | null }) => Promise<void> } };
  user: {
    create: {
      before: (user: { id: string; email: string; name?: string }) => Promise<{ data: Record<string, unknown> }>;
      after: (user: { id: string; email: string; organizationId?: string }) => Promise<void>;
    };
    update: { before: (user: Record<string, unknown>) => Promise<{ data: unknown }> };
  };
};
const hooks = (auth as unknown as { options: { databaseHooks: Hooks } }).options.databaseHooks;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.userFindUnique.mockResolvedValue(admin);
  mocks.inviteFindFirst.mockResolvedValue(null);
  mocks.inviteUpdateMany.mockResolvedValue({ count: 1 });
  mocks.orgCreate.mockImplementation(async ({ data }: { data: { slug: string } }) => ({ id: "org-new", ...data }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SESSION_COOKIE + getSessionUser / getSession / requireAuth / destroySession", () => {
  it("SESSION_COOKIE is the better-auth session cookie name", () => {
    expect(SESSION_COOKIE).toBe("better-auth.session_token");
  });
  it("getSessionUser: no session → null; session → Prisma user; session without user → null", async () => {
    const spy = vi.spyOn(auth.api, "getSession").mockResolvedValue(null as never);
    expect(await getSessionUser()).toBeNull();
    spy.mockResolvedValue({ user: { id: "u1" } } as never);
    expect(await getSessionUser()).toEqual(admin);
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: "u1" } });
    spy.mockResolvedValue({} as never);
    expect(await getSessionUser()).toBeNull();
  });
  it("getSession returns the raw better-auth session", async () => {
    const session = { session: { id: "s1" }, user: { id: "u1" } };
    vi.spyOn(auth.api, "getSession").mockResolvedValue(session as never);
    expect(await getSession()).toBe(session);
  });
  it("requireAuth: null → throws UNAUTHENTICATED; user → returns it", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null as never);
    await expect(requireAuth()).rejects.toThrow("UNAUTHENTICATED");
    vi.spyOn(auth.api, "getSession").mockResolvedValue({ user: { id: "u1" } } as never);
    expect(await requireAuth()).toEqual(admin);
  });
  it("destroySession forwards to better-auth signOut asResponse", async () => {
    const res = new Response(null, { headers: { "set-cookie": "better-auth.session_token=; Path=/" } });
    const spy = vi.spyOn(auth.api, "signOut").mockResolvedValue(res as never);
    expect(await destroySession()).toBe(res);
    expect(spy).toHaveBeenCalledWith({ headers: expect.any(Headers), asResponse: true });
  });
});

describe("requireApiAuth", () => {
  it("no session → 401 unauthenticated", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null as never);
    const res = await requireApiAuth("website.view");
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error.status).toBe(401);
      expect(await res.error.json()).toMatchObject({ error: "unauthenticated" });
    }
  });
  it("session error swallowed → 401 (getSessionUser catches)", async () => {
    vi.spyOn(auth.api, "getSession").mockRejectedValue(new Error("headers boom"));
    const res = await requireApiAuth();
    expect("error" in res).toBe(true);
  });
  it("member without the permission → 403 forbidden; with it (or no permission arg) → user", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue({ user: { id: "u2" } } as never);
    mocks.userFindUnique.mockResolvedValue(member);
    const forbidden = await requireApiAuth("organization.manage");
    expect("error" in forbidden).toBe(true);
    if ("error" in forbidden) expect(forbidden.error.status).toBe(403);
    const ok = await requireApiAuth("analytics.view");
    expect(ok).toEqual({ user: member });
    const noPerm = await requireApiAuth();
    expect(noPerm).toEqual({ user: member });
    vi.spyOn(auth.api, "getSession").mockResolvedValue({ user: { id: "u1" } } as never);
    mocks.userFindUnique.mockResolvedValue(admin);
    expect(await requireApiAuth("organization.manage")).toEqual({ user: admin });
  });
});

describe("requireFreshSession", () => {
  const sessionWith = (createdAt: Date | string) => ({ session: { createdAt }, user: { id: "u1" } });
  it("missing session → 401 session_not_fresh", async () => {
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null as never);
    const res = await requireFreshSession();
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error.status).toBe(401);
      expect(await res.error.json()).toMatchObject({ error: "session_not_fresh" });
    }
  });
  it("stale session (16 min) → 401; fresh session (1 min) → ok", async () => {
    const spy = vi.spyOn(auth.api, "getSession");
    spy.mockResolvedValue(sessionWith(new Date(Date.now() - 16 * 60 * 1000)) as never);
    expect("error" in (await requireFreshSession())).toBe(true);
    spy.mockResolvedValue(sessionWith(new Date(Date.now() - 60 * 1000)) as never);
    expect(await requireFreshSession()).toEqual({ ok: true });
  });
  it("getSession throwing → 401 (caught, treated as not fresh)", async () => {
    vi.spyOn(auth.api, "getSession").mockRejectedValue(new Error("boom"));
    expect("error" in (await requireFreshSession())).toBe(true);
  });
});

describe("apiError (auth helper)", () => {
  it("builds {error, details} with the given status", async () => {
    const res = apiError(404, "not_found", { id: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", details: { id: "x" } });
    const plain = apiError(400, "bad");
    expect(await plain.json()).toEqual({ error: "bad" });
  });
});

describe("better-auth databaseHooks (server.ts)", () => {
  it("session.create.after audits sign-in; missing user → no audit; audit failure swallowed", async () => {
    await hooks.session.create.after({ userId: "u1", ipAddress: "1.2.3.4" });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        actorId: "u1",
        action: "auth.sign_in",
        entityType: "User",
        entityId: "u1",
        ipAddress: "1.2.3.4",
      }),
    );
    mocks.userFindUnique.mockResolvedValueOnce(null);
    mocks.writeAudit.mockClear();
    await hooks.session.create.after({ userId: "ghost" });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    mocks.userFindUnique.mockResolvedValue(admin);
    mocks.writeAudit.mockRejectedValueOnce(new Error("audit down"));
    await expect(hooks.session.create.after({ userId: "u1" })).resolves.toBeUndefined();
  });
  it("user.create.before with a pending invite → joins that org with the invite role", async () => {
    mocks.inviteFindFirst.mockResolvedValue({ organizationId: "org9", role: "TEAM_ADMIN" });
    const res = await hooks.user.create.before({ id: "u9", email: "new@example.com", name: "New" });
    expect(res.data).toMatchObject({ organizationId: "org9", role: "TEAM_ADMIN", email: "new@example.com" });
    expect(mocks.orgCreate).not.toHaveBeenCalled();
    expect(mocks.inviteFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: { equals: "new@example.com", mode: "insensitive" } }),
      }),
    );
  });
  it("user.create.before without an invite → fresh org + SUPER_ADMIN, slug from the name", async () => {
    const res = await hooks.user.create.before({ id: "u9", email: "ann@example.com", name: "Ann Example" });
    expect(res.data).toMatchObject({ organizationId: "org-new", role: "SUPER_ADMIN" });
    expect(mocks.orgCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Ann Example's workspace" }) }),
    );
    const slug = (mocks.orgCreate.mock.calls[0][0] as { data: { slug: string } }).data.slug;
    expect(slug.startsWith("ann-example-")).toBe(true);
  });
  it("user.create.before without a name → slug from the email prefix", async () => {
    const res = await hooks.user.create.before({ id: "u9", email: "bob.smith@example.com" });
    expect(res.data).toMatchObject({ organizationId: "org-new", role: "SUPER_ADMIN" });
    const slug = (mocks.orgCreate.mock.calls[0][0] as { data: { slug: string } }).data.slug;
    expect(slug.startsWith("bob-smith-")).toBe(true);
  });
  it("user.create.after marks the invite accepted + audits sign-up; updateMany failure tolerated", async () => {
    await hooks.user.create.after({ id: "u9", email: "new@example.com", organizationId: "org9" });
    expect(mocks.inviteUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org9" }),
        data: { acceptedAt: expect.any(Date) },
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.sign_up", entityId: "u9" }));
    mocks.inviteUpdateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(
      hooks.user.create.after({ id: "u9", email: "new@example.com", organizationId: "org9" }),
    ).resolves.toBeUndefined();
    mocks.writeAudit.mockClear();
    mocks.inviteUpdateMany.mockClear();
    await hooks.user.create.after({ id: "u9", email: "new@example.com" });
    expect(mocks.inviteUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.sign_up" }));
  });
  it("user.update.before rejects role/organizationId changes, passes clean updates", async () => {
    await expect(hooks.user.update.before({ id: "u1", organizationId: "org2" })).rejects.toThrow(
      "role and organizationId cannot be changed through user update",
    );
    await expect(hooks.user.update.before({ id: "u1", role: "SUPER_ADMIN" })).rejects.toThrow(
      "role and organizationId cannot be changed through user update",
    );
    const user = { id: "u1", name: "Ann", emailVerified: true };
    await expect(hooks.user.update.before(user)).resolves.toEqual({ data: user });
  });
});
