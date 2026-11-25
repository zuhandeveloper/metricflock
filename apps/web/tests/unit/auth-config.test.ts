import { describe, it, expect, vi, beforeEach } from "vitest";

// A-COV-11: the database hooks close over `prisma` and `writeAudit`;
// mock both so the hooks can be INVOKED with fixtures below (the
// shape-only assertions further down are unchanged).
const mocks = vi.hoisted(() => ({
  inviteFindFirst: vi.fn(),
  inviteUpdateMany: vi.fn(),
  orgCreate: vi.fn(),
  userFindUnique: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    organizationInvite: { findFirst: mocks.inviteFindFirst, updateMany: mocks.inviteUpdateMany },
    organization: { create: mocks.orgCreate },
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));

import { auth } from "@metricflock/auth";

// Regression tests for the Stage 1 critical auth fixes (audit AUTH-1/2/3/9).
// These assert the better-auth configuration that closes the mass-assignment
// and account pre-hijacking vectors. The behavioral proof (real sign-up /
// update-user attempts against a live server + database) lives in
// scripts/smoke-test.sh, which runs in CI against real Postgres + Redis.
type HookFn = (arg: never) => Promise<unknown>;
type AnyOptions = {
  user?: { additionalFields?: Record<string, { input?: boolean }> };
  emailAndPassword?: { requireEmailVerification?: boolean; minPasswordLength?: number };
  account?: { accountLinking?: { requireLocalEmailVerified?: boolean } };
  databaseHooks?: {
    session?: { create?: { after?: HookFn } };
    user?: { create?: { before?: HookFn; after?: HookFn }; update?: { before?: HookFn } };
  };
  rateLimit?: { enabled?: boolean; customRules?: Record<string, { window?: number; max?: number }> };
  advanced?: { useSecureCookies?: boolean; ipAddress?: { ipAddressHeaders?: string[] } };
};

const options = (auth as unknown as { options: AnyOptions }).options;

describe("better-auth security configuration", () => {
  it("role is not client-settable (input: false)", () => {
    expect(options.user?.additionalFields?.role?.input).toBe(false);
  });
  it("organizationId is not client-settable (input: false)", () => {
    expect(options.user?.additionalFields?.organizationId?.input).toBe(false);
  });
  it("password accounts require email verification", () => {
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
  });
  it("minimum password length is 12", () => {
    expect(options.emailAndPassword?.minPasswordLength).toBe(12);
  });
  it("provider linking requires a verified local email", () => {
    expect(options.account?.accountLinking?.requireLocalEmailVerified).toBe(true);
  });
  it("user create and update hooks are registered", () => {
    expect(typeof options.databaseHooks?.user?.create?.before).toBe("function");
    expect(typeof options.databaseHooks?.user?.update?.before).toBe("function");
  });
  it("rate limiting is explicitly enabled with strict credential rules (F-2.5)", () => {
    expect(options.rateLimit?.enabled).toBe(true);
    expect(options.rateLimit?.customRules?.["/sign-in/email"]).toEqual({ window: 10, max: 3 });
    expect(options.rateLimit?.customRules?.["/sign-up/email"]).toEqual({ window: 10, max: 3 });
    expect(options.rateLimit?.customRules?.["/change-password"]).toEqual({ window: 10, max: 3 });
  });
  it("secure cookies are tied to production (F-2.5)", () => {
    expect(options.advanced?.useSecureCookies).toBe(process.env.NODE_ENV === "production");
  });
  it("session IPs prefer the platform-set x-real-ip over x-forwarded-for (A-SEC-16)", () => {
    // better-auth defaults to `x-forwarded-for` alone, whose single entry
    // any client can forge — that value feeds the `auth.sign_in` audit
    // rows. `x-real-ip` is set by the hosting platform from the TCP
    // connection (same preference order as A-SEC-05's
    // `clientIpFromHeaders`); XFF is only the fallback.
    expect(options.advanced?.ipAddress?.ipAddressHeaders).toEqual(["x-real-ip", "x-forwarded-for"]);
  });
});

// A-COV-11: invoke the hooks with fixtures and assert their outputs and
// side effects — the typeof checks above only pin that they exist. The
// hooks are the server-side assignment layer for organizationId/role
// (AUTH-1/2): a regression here is a cross-tenant takeover vector, so
// the behaviour is pinned directly, not just the shape.
describe("better-auth database hooks (invoked with fixtures)", () => {
  const createBefore = options.databaseHooks?.user?.create?.before as HookFn;
  const createAfter = options.databaseHooks?.user?.create?.after as HookFn;
  const updateBefore = options.databaseHooks?.user?.update?.before as HookFn;
  const sessionAfter = options.databaseHooks?.session?.create?.after as HookFn;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inviteUpdateMany.mockResolvedValue({ count: 1 });
    mocks.userFindUnique.mockResolvedValue({ organizationId: "org-1" });
    mocks.writeAudit.mockResolvedValue(undefined);
  });

  it("create.before assigns the invited org and role when an invite matches", async () => {
    mocks.inviteFindFirst.mockResolvedValue({ organizationId: "org-inv", role: "TEAM_MEMBER" });
    const user = { email: "Ada@Example.com", name: "Ada" };
    const result = (await createBefore(user as never)) as { data: Record<string, unknown> };
    expect(result.data).toMatchObject({ email: "Ada@Example.com", organizationId: "org-inv", role: "TEAM_MEMBER" });
    expect(mocks.inviteFindFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: "Ada@Example.com", mode: "insensitive" },
        acceptedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(mocks.orgCreate).not.toHaveBeenCalled();
  });

  it("create.before creates a fresh org and SUPER_ADMIN role when no invite matches", async () => {
    mocks.inviteFindFirst.mockResolvedValue(null);
    mocks.orgCreate.mockResolvedValue({ id: "org-new" });
    const user = { email: "ada@example.com", name: "Ada Lovelace" };
    const result = (await createBefore(user as never)) as { data: Record<string, unknown> };
    expect(result.data).toMatchObject({ organizationId: "org-new", role: "SUPER_ADMIN" });
    expect(mocks.orgCreate).toHaveBeenCalledWith({
      data: { name: "Ada Lovelace's workspace", slug: expect.stringMatching(/^ada-lovelace-[0-9a-f]{8}$/) },
    });
  });

  it("create.before derives the slug from the email local part when the name is unusable", async () => {
    mocks.inviteFindFirst.mockResolvedValue(null);
    mocks.orgCreate.mockResolvedValue({ id: "org-new" });
    await createBefore({ email: "bob.smith+tag@example.com", name: "!!!" } as never);
    // "!!!" slugs to "" -> falls back to the "workspace" base.
    expect(mocks.orgCreate).toHaveBeenCalledWith({
      data: { name: "!!!'s workspace", slug: expect.stringMatching(/^workspace-[0-9a-f]{8}$/) },
    });
    vi.clearAllMocks();
    mocks.inviteFindFirst.mockResolvedValue(null);
    mocks.orgCreate.mockResolvedValue({ id: "org-new" });
    await createBefore({ email: "bob.smith+tag@example.com", name: "" } as never);
    expect(mocks.orgCreate).toHaveBeenCalledWith({
      data: { name: "bob.smith+tag's workspace", slug: expect.stringMatching(/^bob-smith-tag-[0-9a-f]{8}$/) },
    });
  });

  it("create.before discards client-supplied organizationId/role on the self-sign-up path", async () => {
    mocks.inviteFindFirst.mockResolvedValue(null);
    mocks.orgCreate.mockResolvedValue({ id: "org-new" });
    const hostile = { email: "eve@example.com", name: "Eve", organizationId: "victim-org", role: "SUPER_ADMIN" };
    const result = (await createBefore(hostile as never)) as { data: Record<string, unknown> };
    expect(result.data.organizationId).toBe("org-new");
    expect(result.data.organizationId).not.toBe("victim-org");
  });

  it("create.after marks the consumed invite accepted and audits the sign-up", async () => {
    const user = { id: "u1", email: "ada@example.com", organizationId: "org-inv" };
    await createAfter(user as never);
    expect(mocks.inviteUpdateMany).toHaveBeenCalledWith({
      where: { email: { equals: "ada@example.com", mode: "insensitive" }, organizationId: "org-inv", acceptedAt: null },
      data: { acceptedAt: expect.any(Date) },
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", actorId: "u1", action: "auth.sign_up", entityId: "u1" }),
    );
  });

  it("create.after skips the invite update when the user has no organizationId", async () => {
    await createAfter({ id: "u2", email: "ada@example.com" } as never);
    expect(mocks.inviteUpdateMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.sign_up" }));
  });

  it("create.after swallows an invite-update failure and still audits", async () => {
    mocks.inviteUpdateMany.mockRejectedValue(new Error("db down"));
    await expect(
      createAfter({ id: "u3", email: "ada@example.com", organizationId: "org-inv" } as never),
    ).resolves.toBeUndefined();
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.sign_up" }));
  });

  it("update.before passes a clean profile update through unchanged", async () => {
    const user = { id: "u1", name: "New Name" };
    await expect(updateBefore(user as never)).resolves.toEqual({ data: user });
  });

  it("update.before rejects role and organizationId changes", async () => {
    await expect(updateBefore({ id: "u1", role: "SUPER_ADMIN" } as never)).rejects.toThrow(
      "role and organizationId cannot be changed through user update",
    );
    await expect(updateBefore({ id: "u1", organizationId: "other-org" } as never)).rejects.toThrow(
      "role and organizationId cannot be changed through user update",
    );
  });

  it("session.create.after audits the sign-in with the session IP", async () => {
    await sessionAfter({ userId: "u1", ipAddress: "203.0.113.7" } as never);
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { organizationId: true } });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "u1", action: "auth.sign_in", ipAddress: "203.0.113.7" }),
    );
  });

  it("session.create.after writes no audit row when the user no longer exists", async () => {
    mocks.userFindUnique.mockResolvedValue(null);
    await sessionAfter({ userId: "ghost", ipAddress: null } as never);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});
