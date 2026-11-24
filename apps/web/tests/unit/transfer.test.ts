import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// A-COV-03 (Stage 1, row 16): real tests of apps/web/src/lib/transfers.ts
// (loadTransferInOrg, expireIfStale, canActForDestination) asserting
// behaviour, not literals, plus route-level tests of the cancel/reject
// routes (mocked Prisma).
//
// Guarded-update contract (agreed across Stage 1 agents, row 2): a
// guarded updateMany affecting 0 rows returns 409 with code
// `invalid_state`, and an audit-write failure must not mask a successful
// mutation. These tests encode that contract against the routes as fixed
// by the guarded-update change (updateMany + findUnique reload +
// audit .catch).
const mocks = vi.hoisted(() => ({
  transferFindFirst: vi.fn(),
  transferFindUnique: vi.fn(),
  transferUpdateMany: vi.fn(),
  teamMemberFindFirst: vi.fn(),
  writeAudit: vi.fn(),
  requireApiAuth: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    websiteTransfer: {
      findFirst: mocks.transferFindFirst,
      findUnique: mocks.transferFindUnique,
      updateMany: mocks.transferUpdateMany,
    },
    teamMember: { findFirst: mocks.teamMemberFindFirst },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/auth", () => ({ requireApiAuth: mocks.requireApiAuth }));

import {
  loadTransferInOrg,
  expireIfStale,
  canActForDestination,
  transferStaleStateResponse,
  OPEN_TRANSFER_STATUSES,
} from "@/lib/transfers";
import { POST as cancelPost } from "@/app/api/transfers/[id]/cancel/route";
import { POST as rejectPost } from "@/app/api/transfers/[id]/reject/route";
import type { TransferStatus, User } from "@metricflock/db";

type TransferRow = {
  id: string;
  status: TransferStatus;
  expiresAt: Date | null;
  initiatedById: string;
  fromTeamId: string;
  toTeamId: string;
  websiteId: string;
  website: { id: string; name: string; domain: string; teamId: string; organizationId: string };
};

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" } as unknown as User;
const member = {
  id: "u2",
  organizationId: "org1",
  role: "TEAM_MEMBER",
  email: "member@example.com",
} as unknown as User;

const openTransfer = (over: Partial<TransferRow> = {}): TransferRow => ({
  id: "t1",
  status: "PENDING_ACCEPTANCE",
  expiresAt: new Date(Date.now() + 86_400_000),
  initiatedById: "u1",
  fromTeamId: "t-from",
  toTeamId: "t-to",
  websiteId: "w1",
  website: { id: "w1", name: "Site", domain: "site.example", teamId: "t-from", organizationId: "org1" },
  ...over,
});

const req = () => new NextRequest("http://localhost/api/transfers/t1/cancel", { method: "POST" });
const ctx = { params: Promise.resolve({ id: "t1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.transferFindFirst.mockResolvedValue(openTransfer());
  mocks.transferFindUnique.mockResolvedValue(openTransfer({ status: "CANCELLED" }));
  mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
  mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true });
  mocks.writeAudit.mockResolvedValue(undefined);
});

describe("loadTransferInOrg", () => {
  it("loads a transfer only when its website belongs to the caller's org", async () => {
    const found = await loadTransferInOrg("t1", "org1");
    expect(found?.id).toBe("t1");
    expect(mocks.transferFindFirst).toHaveBeenCalledWith({
      where: { id: "t1", website: { organizationId: "org1" } },
      include: {
        website: { select: { id: true, name: true, domain: true, teamId: true, organizationId: true } },
      },
    });
  });
  it("returns null for a transfer in another org (caller sees 404)", async () => {
    mocks.transferFindFirst.mockResolvedValue(null);
    await expect(loadTransferInOrg("t1", "org2")).resolves.toBeNull();
    expect(mocks.transferFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1", website: { organizationId: "org2" } } }),
    );
  });
});

describe("expireIfStale", () => {
  it("expires an open transfer past its deadline and persists EXPIRED", async () => {
    const stale = openTransfer({ expiresAt: new Date(Date.now() - 1000) });
    const out = await expireIfStale(stale);
    expect(out.status).toBe("EXPIRED");
    expect(mocks.transferUpdateMany).toHaveBeenCalledWith({
      where: { id: "t1", status: { in: OPEN_TRANSFER_STATUSES } },
      data: { status: "EXPIRED" },
    });
  });
  it("when the expiry guard matches 0 rows it refreshes from the winning state", async () => {
    const stale = openTransfer({ expiresAt: new Date(Date.now() - 1000) });
    mocks.transferUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "COMPLETED" });
    const out = await expireIfStale(stale);
    expect(out.status).toBe("COMPLETED");
  });
  it("leaves a fresh open transfer untouched (no write)", async () => {
    const out = await expireIfStale(openTransfer());
    expect(out.status).toBe("PENDING_ACCEPTANCE");
    expect(mocks.transferUpdateMany).not.toHaveBeenCalled();
  });
  it("leaves a closed transfer untouched even past its deadline", async () => {
    const out = await expireIfStale(openTransfer({ status: "COMPLETED", expiresAt: new Date(Date.now() - 1000) }));
    expect(out.status).toBe("COMPLETED");
    expect(mocks.transferUpdateMany).not.toHaveBeenCalled();
  });
  it("leaves an open transfer with no expiry untouched", async () => {
    const out = await expireIfStale(openTransfer({ expiresAt: null }));
    expect(out.status).toBe("PENDING_ACCEPTANCE");
    expect(mocks.transferUpdateMany).not.toHaveBeenCalled();
  });
});

describe("transferStaleStateResponse", () => {
  it("maps EXPIRED to transfer_expired 409", async () => {
    const res = transferStaleStateResponse("EXPIRED");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "transfer_expired" });
  });
  it("maps any other status to invalid_state 409 with the status", async () => {
    const res = transferStaleStateResponse("COMPLETED");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "invalid_state", status: "COMPLETED" });
  });
});

describe("canActForDestination", () => {
  it("SUPER_ADMIN can always act for the destination", async () => {
    await expect(canActForDestination(admin, "t-to")).resolves.toBe(true);
    expect(mocks.teamMemberFindFirst).not.toHaveBeenCalled();
  });
  it("an isAdmin member of the destination team can act", async () => {
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true });
    await expect(canActForDestination(member, "t-to")).resolves.toBe(true);
    expect(mocks.teamMemberFindFirst).toHaveBeenCalledWith({
      where: { teamId: "t-to", userId: "u2", isAdmin: true },
    });
  });
  it("a non-admin member of the destination team cannot act", async () => {
    mocks.teamMemberFindFirst.mockResolvedValue(null);
    await expect(canActForDestination(member, "t-to")).resolves.toBe(false);
  });
});

describe("POST /api/transfers/[id]/cancel", () => {
  it("unauthenticated → 401", async () => {
    mocks.requireApiAuth.mockResolvedValue({
      error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    });
    const res = await cancelPost(req(), ctx);
    expect(res.status).toBe(401);
    expect(mocks.transferFindFirst).not.toHaveBeenCalled();
  });
  it("cross-org transfer → 404", async () => {
    mocks.transferFindFirst.mockResolvedValue(null);
    const res = await cancelPost(req(), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found_or_forbidden" });
  });
  it("non-initiator non-admin → 403", async () => {
    mocks.requireApiAuth.mockResolvedValue({ user: member });
    const res = await cancelPost(req(), ctx);
    expect(res.status).toBe(403);
  });
  it("initiator can cancel their own open transfer → 200 CANCELLED + audit", async () => {
    mocks.requireApiAuth.mockResolvedValue({ user: member });
    mocks.transferFindFirst.mockResolvedValue(openTransfer({ initiatedById: "u2" }));
    const res = await cancelPost(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).transfer.status).toBe("CANCELLED");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "website.transfer.cancelled", entityType: "Website" }),
    );
  });
  it("stale transfer → 409 transfer_expired (and it was expired first)", async () => {
    mocks.transferFindFirst.mockResolvedValue(openTransfer({ expiresAt: new Date(Date.now() - 1000) }));
    const res = await cancelPost(req(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "transfer_expired" });
  });
  it("already-closed transfer → 409 invalid_state", async () => {
    mocks.transferFindFirst.mockResolvedValue(openTransfer({ status: "COMPLETED" }));
    const res = await cancelPost(req(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invalid_state", status: "COMPLETED" });
  });
});

describe("POST /api/transfers/[id]/reject", () => {
  it("unauthenticated → 401", async () => {
    mocks.requireApiAuth.mockResolvedValue({
      error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    });
    const res = await rejectPost(req(), ctx);
    expect(res.status).toBe(401);
  });
  it("cross-org transfer → 404", async () => {
    mocks.transferFindFirst.mockResolvedValue(null);
    const res = await rejectPost(req(), ctx);
    expect(res.status).toBe(404);
  });
  it("user who cannot act for the destination → 403", async () => {
    mocks.requireApiAuth.mockResolvedValue({ user: member });
    mocks.teamMemberFindFirst.mockResolvedValue(null);
    const res = await rejectPost(req(), ctx);
    expect(res.status).toBe(403);
  });
  it("destination admin rejects PENDING_ACCEPTANCE → 200 CANCELLED + audit", async () => {
    const res = await rejectPost(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).transfer.status).toBe("CANCELLED");
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "website.transfer.rejected" }));
  });
  it("reject from PENDING_CONNECTION → 409 invalid_state (only acceptance can be rejected)", async () => {
    mocks.transferFindFirst.mockResolvedValue(openTransfer({ status: "PENDING_CONNECTION" }));
    const res = await rejectPost(req(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invalid_state", status: "PENDING_CONNECTION" });
  });
});

describe("guarded-update contract (row 2)", () => {
  it("cancel: guarded update affecting 0 rows → 409 invalid_state (loser reads the winning state)", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "COMPLETED" });
    const res = await cancelPost(req(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invalid_state", status: "COMPLETED" });
    expect(mocks.transferUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1", status: { in: OPEN_TRANSFER_STATUSES } } }),
    );
  });
  it("reject: guarded update affecting 0 rows → 409 invalid_state", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "PENDING_CONNECTION" });
    const res = await rejectPost(req(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invalid_state", status: "PENDING_CONNECTION" });
  });
  it("cancel: audit-write failure must not mask the successful mutation", async () => {
    mocks.writeAudit.mockRejectedValue(new Error("audit down"));
    const res = await cancelPost(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).transfer.status).toBe("CANCELLED");
  });
  it("reject: audit-write failure must not mask the successful mutation", async () => {
    mocks.writeAudit.mockRejectedValue(new Error("audit down"));
    const res = await rejectPost(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).transfer.status).toBe("CANCELLED");
  });
});
