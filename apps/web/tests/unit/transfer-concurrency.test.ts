import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { TransferStatus } from "@metricflock/db";

const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  transferFindFirst: vi.fn(),
  transferUpdate: vi.fn(),
  transferUpdateMany: vi.fn(),
  transferFindUnique: vi.fn(),
  googleConnectionFindFirst: vi.fn(),
  txUpdateMany: vi.fn(),
  txFindUnique: vi.fn(),
  txWebsiteUpdate: vi.fn(),
  txAssignDeleteMany: vi.fn(),
  txIntegDeleteMany: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn(),
  invalidateWebsiteCache: vi.fn(),
  invalidateWebsiteSnapshots: vi.fn(),
}));

vi.mock("@metricflock/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireFreshSession: mocks.requireFreshSession,
}));
vi.mock("@metricflock/db", () => ({
  prisma: {
    websiteTransfer: {
      findFirst: mocks.transferFindFirst,
      update: mocks.transferUpdate,
      updateMany: mocks.transferUpdateMany,
      findUnique: mocks.transferFindUnique,
    },
    googleConnection: { findFirst: mocks.googleConnectionFindFirst },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/db/snapshots", () => ({ invalidateWebsiteSnapshots: mocks.invalidateWebsiteSnapshots }));
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, invalidateWebsiteCache: mocks.invalidateWebsiteCache };
});

import { expireIfStale, OPEN_TRANSFER_STATUSES } from "@/lib/transfers";
import { POST as accept } from "@/app/api/transfers/[id]/accept/route";
import { POST as complete } from "@/app/api/transfers/[id]/complete/route";
import { POST as cancel } from "@/app/api/transfers/[id]/cancel/route";
import { POST as reject } from "@/app/api/transfers/[id]/reject/route";

const authUser = { id: "u1", organizationId: "org-a", role: "SUPER_ADMIN" };
const ctx = { params: Promise.resolve({ id: "t1" }) };
const postReq = () => new NextRequest("http://localhost/api/transfers/t1", { method: "POST" });

function transferFixture(status: TransferStatus) {
  return {
    id: "t1",
    websiteId: "w1",
    fromTeamId: "team-a",
    toTeamId: "team-b",
    initiatedById: "u1",
    status,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    website: { id: "w1", name: "Site", domain: "site.example", teamId: "team-a", organizationId: "org-a" },
  };
}

// A-DB-01: every transfer transition must be a guarded updateMany
// (expected status in the where clause) so exactly one of two racing
// requests wins and the loser gets 409 invalid_state. With mocked
// Prisma the test proves the guard is issued (and, for complete, that
// it runs inside the transaction before any side effect) and that a
// 0-row result yields 409. True concurrency against a real DB is
// CI-smoke territory — mocks cannot prove two transactions serialize.
describe("accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: authUser });
    mocks.transferFindFirst.mockResolvedValue(transferFixture("PENDING_ACCEPTANCE"));
    mocks.writeAudit.mockResolvedValue(undefined);
  });

  it("accepts with a guarded updateMany and returns the updated row", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transferFindUnique.mockResolvedValue({ ...transferFixture("PENDING_CONNECTION") });
    const res = await accept(postReq(), ctx);
    expect(res.status).toBe(200);
    expect(mocks.transferUpdateMany).toHaveBeenCalledWith({
      where: { id: "t1", status: "PENDING_ACCEPTANCE" },
      data: expect.objectContaining({ status: "PENDING_CONNECTION" }),
    });
    expect(mocks.transferUpdate).not.toHaveBeenCalled();
    expect((await res.json()).transfer.status).toBe("PENDING_CONNECTION");
  });

  it("returns 409 invalid_state when the guard matches 0 rows (accept lost the race)", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "CANCELLED" });
    const res = await accept(postReq(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "invalid_state",
      requestId: expect.any(String),
      details: { status: "CANCELLED" },
    });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("still returns 200 when the audit write fails (audit must not mask the mutation)", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transferFindUnique.mockResolvedValue({ ...transferFixture("PENDING_CONNECTION") });
    mocks.writeAudit.mockRejectedValue(new Error("audit down"));
    const res = await accept(postReq(), ctx);
    expect(res.status).toBe(200);
  });
});

describe("complete", () => {
  const tx = {
    websiteTransfer: { updateMany: mocks.txUpdateMany, findUnique: mocks.txFindUnique },
    website: { update: mocks.txWebsiteUpdate },
    websiteAssignment: { deleteMany: mocks.txAssignDeleteMany },
    websiteIntegration: { deleteMany: mocks.txIntegDeleteMany },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: authUser });
    mocks.requireFreshSession.mockResolvedValue({ ok: true });
    mocks.transferFindFirst.mockResolvedValue(transferFixture("PENDING_CONNECTION"));
    mocks.googleConnectionFindFirst.mockResolvedValue({ id: "conn-1" });
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.invalidateWebsiteCache.mockResolvedValue(undefined);
    mocks.invalidateWebsiteSnapshots.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
  });

  it("guards the status FIRST inside the transaction, then moves the website", async () => {
    mocks.txUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txFindUnique.mockResolvedValue({ ...transferFixture("COMPLETED") });
    const res = await complete(postReq(), ctx);
    expect(res.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.txUpdateMany).toHaveBeenCalledWith({
      where: { id: "t1", status: "PENDING_CONNECTION" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
    // The guard runs before any side effect.
    expect(mocks.txUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txWebsiteUpdate.mock.invocationCallOrder[0],
    );
    expect(mocks.txWebsiteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "w1" }, data: { teamId: "team-b", status: "ACTIVE" } }),
    );
    expect(mocks.txAssignDeleteMany).toHaveBeenCalled();
    expect(mocks.txIntegDeleteMany).toHaveBeenCalled();
    expect((await res.json()).transfer.status).toBe("COMPLETED");
  });

  it("returns 409 and runs NO side effect when the in-transaction guard matches 0 rows", async () => {
    mocks.txUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "CANCELLED" });
    const res = await complete(postReq(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "invalid_state",
      requestId: expect.any(String),
      details: { status: "CANCELLED" },
    });
    expect(mocks.txWebsiteUpdate).not.toHaveBeenCalled();
    expect(mocks.txAssignDeleteMany).not.toHaveBeenCalled();
    expect(mocks.txIntegDeleteMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("still returns 200 when the audit write fails", async () => {
    mocks.txUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txFindUnique.mockResolvedValue({ ...transferFixture("COMPLETED") });
    mocks.writeAudit.mockRejectedValue(new Error("audit down"));
    const res = await complete(postReq(), ctx);
    expect(res.status).toBe(200);
  });
});

describe("cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: authUser });
    mocks.transferFindFirst.mockResolvedValue(transferFixture("PENDING_ACCEPTANCE"));
    mocks.writeAudit.mockResolvedValue(undefined);
  });

  it("cancels with a guarded updateMany over the open statuses", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transferFindUnique.mockResolvedValue({ ...transferFixture("CANCELLED") });
    const res = await cancel(postReq(), ctx);
    expect(res.status).toBe(200);
    expect(mocks.transferUpdateMany).toHaveBeenCalledWith({
      where: { id: "t1", status: { in: ["PENDING_ACCEPTANCE", "PENDING_CONNECTION"] } },
      data: { status: "CANCELLED" },
    });
    expect(mocks.transferUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 invalid_state when the guard matches 0 rows (cancel lost the race)", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "COMPLETED" });
    const res = await cancel(postReq(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "invalid_state",
      requestId: expect.any(String),
      details: { status: "COMPLETED" },
    });
  });
});

describe("reject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: authUser });
    mocks.transferFindFirst.mockResolvedValue(transferFixture("PENDING_ACCEPTANCE"));
    mocks.writeAudit.mockResolvedValue(undefined);
  });

  it("rejects with a guarded updateMany", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transferFindUnique.mockResolvedValue({ ...transferFixture("CANCELLED") });
    const res = await reject(postReq(), ctx);
    expect(res.status).toBe(200);
    expect(mocks.transferUpdateMany).toHaveBeenCalledWith({
      where: { id: "t1", status: "PENDING_ACCEPTANCE" },
      data: { status: "CANCELLED" },
    });
    expect(mocks.transferUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 invalid_state when the guard matches 0 rows", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "PENDING_CONNECTION" });
    const res = await reject(postReq(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "invalid_state",
      requestId: expect.any(String),
      details: { status: "PENDING_CONNECTION" },
    });
  });
});

describe("expireIfStale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expires with a guarded updateMany over the open statuses", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
    const out = await expireIfStale({
      ...transferFixture("PENDING_ACCEPTANCE"),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(out.status).toBe("EXPIRED");
    expect(mocks.transferUpdateMany).toHaveBeenCalledWith({
      where: { id: "t1", status: { in: ["PENDING_ACCEPTANCE", "PENDING_CONNECTION"] } },
      data: { status: "EXPIRED" },
    });
  });

  it("refreshes from the winning state when the expiry guard matches 0 rows", async () => {
    mocks.transferUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "COMPLETED" });
    const out = await expireIfStale({
      ...transferFixture("PENDING_ACCEPTANCE"),
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(out.status).toBe("COMPLETED");
  });
});

describe("OPEN_TRANSFER_STATUSES", () => {
  it("contains only the two reachable open states (A-DB-14: INITIATED is dead)", () => {
    expect([...OPEN_TRANSFER_STATUSES].sort()).toEqual(["PENDING_ACCEPTANCE", "PENDING_CONNECTION"]);
  });
});
