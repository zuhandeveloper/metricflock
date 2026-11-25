import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// A-DB-09: transfer-complete has no audit inside its transaction (the
// route file carries the A-DB-04 fix and is out of scope here), so its
// audit write is best-effort: a failing audit must not turn a committed
// completion into a 500, and the failure must be logged (the logging
// itself is covered at the writeAudit level in audit-write.test.ts —
// here the audit module is mocked, so this file proves the route still
// returns success when the audit write fails).
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  writeAudit: vi.fn(),
  connFindFirst: vi.fn(),
  tx: vi.fn(),
  transferUpdateManyTx: vi.fn(),
  websiteUpdateTx: vi.fn(),
  assignmentDeleteManyTx: vi.fn(),
  integrationDeleteManyTx: vi.fn(),
  transferFindUniqueTx: vi.fn(),
  invalidateWebsiteCache: vi.fn(),
  invalidateWebsiteSnapshots: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
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
vi.mock("@/lib/transfers", () => ({
  loadTransferInOrg: vi.fn(),
  expireIfStale: vi.fn(),
  canActForDestination: vi.fn(),
  // A-API-11: mirrors the real helper — the observed status lives in `details`.
  transferStaleStateResponse: (status: string) =>
    NextResponse.json({ error: "invalid_state", details: { status }, requestId: "test-request-id" }, { status: 409 }),
}));

import { POST as completePost } from "@/app/api/transfers/[id]/complete/route";
import { loadTransferInOrg, expireIfStale, canActForDestination } from "@/lib/transfers";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const transfer = {
  id: "tr1",
  websiteId: "w1",
  fromTeamId: "t1",
  toTeamId: "t2",
  initiatedById: "u1",
  status: "PENDING_CONNECTION",
  websiteStatusBefore: null,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
};
const updated = { ...transfer, status: "COMPLETED" };

describe("POST /api/transfers/[id]/complete — audit failure (A-DB-09)", () => {
  const url = "http://localhost/api/transfers/tr1/complete";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue({ user: admin });
    mocks.requireFreshSession.mockResolvedValue({ ok: true as const });
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.invalidateWebsiteCache.mockResolvedValue(undefined);
    mocks.invalidateWebsiteSnapshots.mockResolvedValue(undefined);
    vi.mocked(loadTransferInOrg).mockResolvedValue(transfer as never);
    vi.mocked(expireIfStale).mockResolvedValue(transfer as never);
    vi.mocked(canActForDestination).mockResolvedValue(true);
    mocks.connFindFirst.mockResolvedValue({ id: "conn-dest" });
    mocks.transferUpdateManyTx.mockResolvedValue({ count: 1 });
    mocks.transferFindUniqueTx.mockResolvedValue(updated);
    mocks.tx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        websiteTransfer: { updateMany: mocks.transferUpdateManyTx, findUnique: mocks.transferFindUniqueTx },
        website: { update: mocks.websiteUpdateTx },
        websiteAssignment: { deleteMany: mocks.assignmentDeleteManyTx },
        websiteIntegration: { deleteMany: mocks.integrationDeleteManyTx },
      }),
    );
  });

  it("valid → 200 completed + audit", async () => {
    const res = await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(res.status).toBe(200);
    expect((await res.json()).transfer.status).toBe("COMPLETED");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "website.transfer.completed", entityId: "w1" }),
    );
  });

  it("audit failure → still 200: the committed completion is not masked as a failure", async () => {
    mocks.writeAudit.mockRejectedValue(new Error("audit down"));
    const res = await completePost(new NextRequest(url, { method: "POST" }), ctx("tr1"));
    expect(res.status).toBe(200);
    expect((await res.json()).transfer.status).toBe("COMPLETED");
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
  });
});
