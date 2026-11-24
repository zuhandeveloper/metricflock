import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Coverage-gap closure: website transfer initiation + accept/complete.
// Cancel/reject are covered in transfer.test.ts; the step-up gate on
// complete is covered in stepup.test.ts. Pattern follows
// routes-v1-analytics.test.ts — mocked Prisma + auth; the lib/transfers
// helpers (loadTransferInOrg, expireIfStale, canActForDestination) run
// for real against the mocked Prisma client.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  writeAudit: vi.fn(),
  websiteFindFirst: vi.fn(),
  teamFindFirst: vi.fn(),
  teamMemberFindFirst: vi.fn(),
  transferFindFirst: vi.fn(),
  transferFindUnique: vi.fn(),
  transferCreate: vi.fn(),
  transferUpdateMany: vi.fn(),
  websiteTransferUpdateManyTx: vi.fn(),
  websiteUpdateTx: vi.fn(),
  assignmentDeleteManyTx: vi.fn(),
  integrationDeleteManyTx: vi.fn(),
  transferFindUniqueTx: vi.fn(),
  connFindFirst: vi.fn(),
  tx: vi.fn(),
  invalidateWebsiteCache: vi.fn(),
  invalidateWebsiteSnapshots: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    website: { findFirst: mocks.websiteFindFirst },
    team: { findFirst: mocks.teamFindFirst },
    teamMember: { findFirst: mocks.teamMemberFindFirst },
    websiteTransfer: {
      findFirst: mocks.transferFindFirst,
      findUnique: mocks.transferFindUnique,
      create: mocks.transferCreate,
      updateMany: mocks.transferUpdateMany,
    },
    googleConnection: { findFirst: mocks.connFindFirst },
    $transaction: mocks.tx,
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/db/snapshots", () => ({ invalidateWebsiteSnapshots: mocks.invalidateWebsiteSnapshots }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    requireFreshSession: mocks.requireFreshSession,
  };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, invalidateWebsiteCache: mocks.invalidateWebsiteCache };
});

import { POST as initiatePost } from "@/app/api/websites/[id]/transfer/route";
import { POST as acceptPost } from "@/app/api/transfers/[id]/accept/route";
import { POST as completePost } from "@/app/api/transfers/[id]/complete/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const unauth = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const website = { id: "w1", organizationId: "org1", teamId: "t1", name: "Site", domain: "site.example" };
const transfer = {
  id: "tr1",
  websiteId: "w1",
  fromTeamId: "t1",
  toTeamId: "t2",
  initiatedById: "u1",
  status: "PENDING_ACCEPTANCE",
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  website: { id: "w1", name: "Site", domain: "site.example", teamId: "t1", organizationId: "org1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.requireFreshSession.mockResolvedValue({ ok: true as const });
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.invalidateWebsiteCache.mockResolvedValue(undefined);
  mocks.invalidateWebsiteSnapshots.mockResolvedValue(undefined);
  mocks.tx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      websiteTransfer: { updateMany: mocks.websiteTransferUpdateManyTx, findUnique: mocks.transferFindUniqueTx },
      website: { update: mocks.websiteUpdateTx },
      websiteAssignment: { deleteMany: mocks.assignmentDeleteManyTx },
      websiteIntegration: { deleteMany: mocks.integrationDeleteManyTx },
    }),
  );
});

describe("POST /api/websites/[id]/transfer", () => {
  const url = "http://localhost/api/websites/w1/transfer";
  beforeEach(() => {
    mocks.websiteFindFirst.mockResolvedValue(website);
    mocks.teamFindFirst.mockResolvedValue({ id: "t2", organizationId: "org1" });
    mocks.transferFindFirst.mockResolvedValue(null);
    mocks.transferCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "tr1",
      ...data,
    }));
  });
  it("unauthenticated → 401; invalid input → 400", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await initiatePost(jsonReq(url, "POST", { toTeamId: "t2" }), ctx("w1"))).status).toBe(401);
    const bad = await initiatePost(jsonReq(url, "POST", {}), ctx("w1"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_input" });
  });
  it("unknown website → 404; unknown destination team → 404; same team → 400", async () => {
    mocks.websiteFindFirst.mockResolvedValueOnce(null);
    const noSite = await initiatePost(jsonReq(url, "POST", { toTeamId: "t2" }), ctx("w1"));
    expect(noSite.status).toBe(404);
    expect(await noSite.json()).toMatchObject({ error: "not_found_or_forbidden" });
    mocks.teamFindFirst.mockResolvedValueOnce(null);
    const noTeam = await initiatePost(jsonReq(url, "POST", { toTeamId: "t9" }), ctx("w1"));
    expect(noTeam.status).toBe(404);
    expect(await noTeam.json()).toMatchObject({ error: "destination_team_not_found" });
    mocks.teamFindFirst.mockResolvedValueOnce({ id: "t1", organizationId: "org1" });
    const same = await initiatePost(jsonReq(url, "POST", { toTeamId: "t1" }), ctx("w1"));
    expect(same.status).toBe(400);
    expect(await same.json()).toMatchObject({ error: "already_in_team" });
  });
  it("open transfer exists → 409 transfer_in_progress", async () => {
    mocks.transferFindFirst.mockResolvedValue({ id: "tr0", status: "PENDING_ACCEPTANCE" });
    const res = await initiatePost(jsonReq(url, "POST", { toTeamId: "t2" }), ctx("w1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "transfer_in_progress", transferId: "tr0" });
    expect(mocks.transferCreate).not.toHaveBeenCalled();
  });
  it("P2002 race → 409 with the winning transferId (or without, if none found)", async () => {
    mocks.transferCreate.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    // Open check → null, re-query after the race → the winning transfer.
    mocks.transferFindFirst
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ id: "tr-race" }));
    const raced = await initiatePost(jsonReq(url, "POST", { toTeamId: "t2" }), ctx("w1"));
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ error: "transfer_in_progress", transferId: "tr-race" });
    mocks.transferCreate.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    mocks.transferFindFirst.mockImplementationOnce(async () => null).mockImplementationOnce(async () => null);
    const racedGone = await initiatePost(jsonReq(url, "POST", { toTeamId: "t2" }), ctx("w1"));
    expect(racedGone.status).toBe(409);
    expect(await racedGone.json()).toEqual({ error: "transfer_in_progress", requestId: expect.any(String) });
    mocks.transferCreate.mockRejectedValueOnce(new Error("boom"));
    const err = await initiatePost(jsonReq(url, "POST", { toTeamId: "t2" }), ctx("w1"));
    expect(err.status).toBe(500);
    expect(await err.json()).toMatchObject({ error: "internal_error" });
  });
  it("valid → 200 transfer + note + audit website.transfer.initiated", async () => {
    const res = await initiatePost(jsonReq(url, "POST", { toTeamId: "t2", reason: "team restructure" }), ctx("w1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transfer).toMatchObject({
      websiteId: "w1",
      fromTeamId: "t1",
      toTeamId: "t2",
      status: "PENDING_ACCEPTANCE",
      reason: "team restructure",
    });
    expect(body.note).toContain("destination team's admin must accept");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "website.transfer.initiated",
        entityType: "Website",
        entityId: "w1",
        details: expect.objectContaining({ fromTeamId: "t1", toTeamId: "t2", transferId: "tr1" }),
      }),
    );
  });
});

describe("POST /api/transfers/[id]/accept", () => {
  const url = "http://localhost/api/transfers/tr1/accept";
  beforeEach(() => {
    mocks.transferFindFirst.mockResolvedValue(transfer);
    mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transferFindUnique.mockResolvedValue({ ...transfer, status: "PENDING_CONNECTION" });
  });
  it("unauthenticated → 401; unknown transfer → 404; non-destination user → 403", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await acceptPost(new NextRequest(url, { method: "POST" }), ctx("tr1"))).status).toBe(401);
    mocks.transferFindFirst.mockResolvedValueOnce(null);
    expect((await acceptPost(new NextRequest(url, { method: "POST" }), ctx("tr1"))).status).toBe(404);
    mocks.requireApiAuth.mockResolvedValueOnce({ user: { ...admin, role: "TEAM_MEMBER" } });
    mocks.teamMemberFindFirst.mockResolvedValue(null);
    const forbidden = await acceptPost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "forbidden" });
  });
  it("expired transfer → 409 transfer_expired (lazy expiry flips it)", async () => {
    mocks.transferFindFirst.mockResolvedValue({ ...transfer, expiresAt: new Date(Date.now() - 1000) });
    mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
    const res = await acceptPost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "transfer_expired" });
  });
  it("wrong state → 409 invalid_state; guarded-update loser → 409 stale state", async () => {
    mocks.transferFindFirst.mockResolvedValue({ ...transfer, status: "PENDING_CONNECTION" });
    const wrong = await acceptPost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ error: "invalid_state", status: "PENDING_CONNECTION" });
    mocks.transferFindFirst.mockResolvedValue(transfer);
    mocks.transferUpdateMany.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "CANCELLED" });
    const stale = await acceptPost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "invalid_state", status: "CANCELLED" });
  });
  it("valid → 200 + audit website.transfer.accepted", async () => {
    const res = await acceptPost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transfer).toMatchObject({ status: "PENDING_CONNECTION" });
    expect(body.note).toContain("Connect the destination team's Google account");
    expect(mocks.transferUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tr1", status: "PENDING_ACCEPTANCE" },
        data: expect.objectContaining({ status: "PENDING_CONNECTION", acceptedById: "u1" }),
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "website.transfer.accepted", entityId: "w1" }),
    );
  });
});

describe("POST /api/transfers/[id]/complete", () => {
  const url = "http://localhost/api/transfers/tr1/complete";
  const pendingConnection = { ...transfer, status: "PENDING_CONNECTION" };
  beforeEach(() => {
    mocks.transferFindFirst.mockResolvedValue(pendingConnection);
    mocks.connFindFirst.mockResolvedValue({ id: "conn-dest" });
    mocks.websiteTransferUpdateManyTx.mockResolvedValue({ count: 1 });
    mocks.websiteUpdateTx.mockResolvedValue({});
    mocks.assignmentDeleteManyTx.mockResolvedValue({ count: 2 });
    mocks.integrationDeleteManyTx.mockResolvedValue({ count: 1 });
    mocks.transferFindUniqueTx.mockResolvedValue({ ...pendingConnection, status: "COMPLETED" });
  });
  it("unauthenticated → 401; unknown transfer → 404; non-destination user → 403", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"))).status).toBe(401);
    mocks.transferFindFirst.mockResolvedValueOnce(null);
    expect((await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"))).status).toBe(404);
    mocks.requireApiAuth.mockResolvedValueOnce({ user: { ...admin, role: "TEAM_MEMBER" } });
    mocks.teamMemberFindFirst.mockResolvedValue(null);
    const forbidden = await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(forbidden.status).toBe(403);
  });
  it("expired → 409 transfer_expired; wrong state → 409 invalid_state", async () => {
    mocks.transferFindFirst.mockResolvedValue({ ...pendingConnection, expiresAt: new Date(Date.now() - 1000) });
    mocks.transferUpdateMany.mockResolvedValue({ count: 1 });
    const expired = await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ error: "transfer_expired" });
    mocks.transferFindFirst.mockResolvedValue({ ...transfer, status: "PENDING_ACCEPTANCE" });
    const wrong = await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ error: "invalid_state", status: "PENDING_ACCEPTANCE" });
  });
  it("destination not connected → 409 destination_not_connected", async () => {
    mocks.connFindFirst.mockResolvedValue(null);
    const res = await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "destination_not_connected" });
    expect(mocks.tx).not.toHaveBeenCalled();
  });
  it("guarded-update loser → 409 stale state", async () => {
    mocks.websiteTransferUpdateManyTx.mockResolvedValue({ count: 0 });
    mocks.transferFindUnique.mockResolvedValue({ status: "COMPLETED" });
    const res = await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "invalid_state", status: "COMPLETED" });
    expect(mocks.websiteUpdateTx).not.toHaveBeenCalled();
  });
  it("valid → 200 completed + website moved + mappings cleared + audit + invalidates", async () => {
    const res = await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transfer).toMatchObject({ status: "COMPLETED" });
    expect(body.note).toContain("discover and map its properties");
    expect(mocks.websiteTransferUpdateManyTx).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tr1", status: "PENDING_CONNECTION" },
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
    expect(mocks.websiteUpdateTx).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "w1" }, data: { teamId: "t2", status: "ACTIVE" } }),
    );
    expect(mocks.assignmentDeleteManyTx).toHaveBeenCalledWith({ where: { websiteId: "w1" } });
    expect(mocks.integrationDeleteManyTx).toHaveBeenCalledWith({ where: { websiteId: "w1" } });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "website.transfer.completed",
        entityType: "Website",
        entityId: "w1",
        details: expect.objectContaining({ transferId: "tr1", destinationConnectionId: "conn-dest" }),
      }),
    );
    expect(mocks.invalidateWebsiteCache).toHaveBeenCalledWith("org1", "w1");
    expect(mocks.invalidateWebsiteSnapshots).toHaveBeenCalledWith("w1");
  });
});
