import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  orgFindUnique: vi.fn(),
  orgAuditExportFindFirst: vi.fn(),
  orgUserCount: vi.fn(),
  orgWebsiteCount: vi.fn(),
  orgTeamCount: vi.fn(),
  orgGoogleConnections: vi.fn(),
  orgTxAuditDeleteMany: vi.fn(),
  orgTxOrgDelete: vi.fn(),
  tx: vi.fn(),
  revokeConnectionToken: vi.fn(),
}));

vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    requireFreshSession: mocks.requireFreshSession,
  };
});
vi.mock("@metricflock/db", () => ({
  prisma: {
    organization: { findUnique: mocks.orgFindUnique },
    auditLog: { findFirst: mocks.orgAuditExportFindFirst },
    user: { count: mocks.orgUserCount },
    website: { count: mocks.orgWebsiteCount },
    team: { count: mocks.orgTeamCount },
    googleConnection: { findMany: mocks.orgGoogleConnections },
    $transaction: mocks.tx,
  },
}));
vi.mock("@metricflock/google/tokens", () => ({
  revokeConnectionToken: mocks.revokeConnectionToken,
}));
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual };
});

import { DELETE as deleteOrg } from "@/app/api/organization/route";

const authUser = { id: "u1", organizationId: "org-a", role: "SUPER_ADMIN" };

// Revoke material the route captures before the delete transaction
// (encrypted refresh token + AAD parts; the rows cascade away with
// the org, so this is all revoke has to work with afterwards).
const connA = {
  id: "conn-a",
  encryptedRefreshToken: "enc-a",
  organizationId: "org-a",
  ownerType: "TEAM",
  ownerId: "team-1",
  googleAccountEmail: "a@example.com",
};
const connB = {
  id: "conn-b",
  encryptedRefreshToken: "enc-b",
  organizationId: "org-a",
  ownerType: "WEBSITE",
  ownerId: "site-1",
  googleAccountEmail: "b@example.com",
};

function deleteRequest() {
  return new NextRequest("http://localhost/api/organization", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmSlug: "main-org" }),
  });
}

// A-DB-06: organisation delete revoked Google tokens BEFORE the delete
// transaction, so a failed delete destroyed every token while the org
// survived. Tokens must now be revoked only after the transaction
// commits — and never when it fails.
describe("DELETE /api/organization — A-DB-06 revoke-after-delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: authUser });
    mocks.requireFreshSession.mockResolvedValue({ ok: true as const });
    mocks.orgFindUnique.mockResolvedValue({ id: "org-a", slug: "main-org", name: "Main" });
    // A-SEC-19: a completed export exists by default (the
    // `organization.exported` audit row the export route leaves).
    mocks.orgAuditExportFindFirst.mockResolvedValue({ id: "audit-export-1" });
    mocks.orgUserCount.mockResolvedValue(3);
    mocks.orgWebsiteCount.mockResolvedValue(5);
    mocks.orgTeamCount.mockResolvedValue(2);
    mocks.orgTxAuditDeleteMany.mockResolvedValue({ count: 3 });
    mocks.orgTxOrgDelete.mockResolvedValue({ id: "org-a" });
    // Default $transaction: run the callback against the fake tx client.
    mocks.tx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        auditLog: { deleteMany: mocks.orgTxAuditDeleteMany },
        organization: { delete: mocks.orgTxOrgDelete },
      }),
    );
    mocks.revokeConnectionToken.mockResolvedValue(true);
  });

  it("failed delete transaction → 500, no token revoked, org delete never ran", async () => {
    mocks.orgGoogleConnections.mockResolvedValue([connA, connB]);
    // Injected fault: the transaction itself fails.
    mocks.tx.mockRejectedValueOnce(new Error("injected fault"));
    const res = await deleteOrg(deleteRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("internal_error");
    // The connections/tokens are untouched: revoke was never attempted…
    expect(mocks.revokeConnectionToken).not.toHaveBeenCalled();
    // …and the org was never deleted inside the (failed) transaction.
    expect(mocks.orgTxOrgDelete).not.toHaveBeenCalled();
    expect(mocks.orgTxAuditDeleteMany).not.toHaveBeenCalled();
  });

  it("successful delete → tokens revoked AFTER the transaction, with the captured material", async () => {
    mocks.orgGoogleConnections.mockResolvedValue([connA, connB]);
    const res = await deleteOrg(deleteRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(mocks.tx).toHaveBeenCalledTimes(1);
    expect(mocks.orgTxOrgDelete).toHaveBeenCalledWith({ where: { id: "org-a" } });
    expect(mocks.revokeConnectionToken).toHaveBeenCalledTimes(2);
    expect(mocks.revokeConnectionToken).toHaveBeenCalledWith(connA);
    expect(mocks.revokeConnectionToken).toHaveBeenCalledWith(connB);
    // Revoke ran strictly after the transaction was invoked.
    const txOrder = mocks.tx.mock.invocationCallOrder[0];
    for (const order of mocks.revokeConnectionToken.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(txOrder);
    }
  });

  it("one revoke failing is best-effort → still 200, every connection attempted", async () => {
    mocks.orgGoogleConnections.mockResolvedValue([connA, connB]);
    mocks.revokeConnectionToken.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const res = await deleteOrg(deleteRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(mocks.revokeConnectionToken).toHaveBeenCalledTimes(2);
  });
});

// A-SEC-19: the audit trail is deleted with the org, so deletion is
// refused until a completed export exists — and the deletion itself is
// logged at error level with actor + slug + counts, the durable record
// once the audit rows are gone.
describe("DELETE /api/organization — A-SEC-19 export gate + error log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: authUser });
    mocks.requireFreshSession.mockResolvedValue({ ok: true as const });
    mocks.orgFindUnique.mockResolvedValue({ id: "org-a", slug: "main-org", name: "Main" });
    mocks.orgAuditExportFindFirst.mockResolvedValue({ id: "audit-export-1" });
    mocks.orgUserCount.mockResolvedValue(3);
    mocks.orgWebsiteCount.mockResolvedValue(5);
    mocks.orgTeamCount.mockResolvedValue(2);
    mocks.orgTxAuditDeleteMany.mockResolvedValue({ count: 3 });
    mocks.orgTxOrgDelete.mockResolvedValue({ id: "org-a" });
    mocks.tx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        auditLog: { deleteMany: mocks.orgTxAuditDeleteMany },
        organization: { delete: mocks.orgTxOrgDelete },
      }),
    );
    mocks.revokeConnectionToken.mockResolvedValue(true);
  });

  it("no completed export → 409 export_required, nothing deleted, no token revoked", async () => {
    mocks.orgAuditExportFindFirst.mockResolvedValue(null);
    const res = await deleteOrg(deleteRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("export_required");
    // The gate fires before any side effect: no connection fetch, no
    // transaction, no revoke.
    expect(mocks.orgGoogleConnections).not.toHaveBeenCalled();
    expect(mocks.tx).not.toHaveBeenCalled();
    expect(mocks.orgTxOrgDelete).not.toHaveBeenCalled();
    expect(mocks.orgTxAuditDeleteMany).not.toHaveBeenCalled();
    expect(mocks.revokeConnectionToken).not.toHaveBeenCalled();
  });

  it("successful delete → error-level log carries actor, slug, member/website/team counts", async () => {
    mocks.orgGoogleConnections.mockResolvedValue([connA, connB]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await deleteOrg(deleteRequest());
      expect(res.status).toBe(200);
      const lines = errorSpy.mock.calls
        .map(([first]) => String(first))
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((parsed): parsed is Record<string, unknown> => parsed !== null);
      const deletion = lines.find((parsed) => parsed.msg === "organization deleted");
      expect(deletion).toBeDefined();
      expect(deletion?.level).toBe("error");
      expect(deletion?.context).toBe("organization-delete");
      expect(deletion?.actorId).toBe("u1");
      expect(deletion?.slug).toBe("main-org");
      expect(deletion?.members).toBe(3);
      expect(deletion?.websites).toBe(5);
      expect(deletion?.teams).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
