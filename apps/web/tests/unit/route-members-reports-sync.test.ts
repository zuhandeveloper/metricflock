import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Coverage-gap closure: members, report schedule, sync, metrics,
// organization export/delete, API keys. Pattern follows
// routes-v1-analytics.test.ts — mocked Prisma + auth + jobs; the
// step-up gate itself is covered in stepup.test.ts, this file covers
// the remaining branches of the same routes.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  getSessionUser: vi.fn(),
  writeAudit: vi.fn(),
  rateLimit: vi.fn(),
  sendMail: vi.fn(),
  userFindFirst: vi.fn(),
  userFindMany: vi.fn(),
  userCount: vi.fn(),
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
  teamFindMany: vi.fn(),
  teamCount: vi.fn(),
  websiteFindMany: vi.fn(),
  websiteFindFirst: vi.fn(),
  websiteCount: vi.fn(),
  websiteTransferCount: vi.fn(),
  connCount: vi.fn(),
  connFindMany: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteCreate: vi.fn(),
  inviteUpdate: vi.fn(),
  inviteDeleteMany: vi.fn(),
  orgFindUnique: vi.fn(),
  orgDelete: vi.fn(),
  orgGoogleConnections: vi.fn(),
  orgTxAuditDeleteMany: vi.fn(),
  orgTxOrgDelete: vi.fn(),
  transferFindMany: vi.fn(),
  scheduleFindUnique: vi.fn(),
  scheduleUpsert: vi.fn(),
  syncJobCreate: vi.fn(),
  syncJobUpdate: vi.fn(),
  syncJobFindFirst: vi.fn(),
  syncJobFindMany: vi.fn(),
  syncJobCount: vi.fn(),
  syncJobGroupBy: vi.fn(),
  apiKeyFindMany: vi.fn(),
  apiKeyFindFirst: vi.fn(),
  apiKeyCreate: vi.fn(),
  apiKeyUpdate: vi.fn(),
  enqueue: vi.fn(),
  getQueue: vi.fn(),
  counterSnapshot: vi.fn(),
  revokeConnection: vi.fn(),
  tx: vi.fn(),
  txQueryRaw: vi.fn(),
  txUserCount: vi.fn(),
  txUserUpdate: vi.fn(),
  txUserDelete: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    user: {
      findFirst: mocks.userFindFirst,
      findMany: mocks.userFindMany,
      count: mocks.userCount,
      update: mocks.userUpdate,
      delete: mocks.userDelete,
    },
    team: { findMany: mocks.teamFindMany, count: mocks.teamCount },
    website: { findMany: mocks.websiteFindMany, findFirst: mocks.websiteFindFirst, count: mocks.websiteCount },
    websiteTransfer: { count: mocks.websiteTransferCount, findMany: mocks.transferFindMany },
    googleConnection: { count: mocks.connCount, findMany: mocks.connFindMany },
    organizationInvite: {
      findFirst: mocks.inviteFindFirst,
      create: mocks.inviteCreate,
      update: mocks.inviteUpdate,
      deleteMany: mocks.inviteDeleteMany,
    },
    organization: { findUnique: mocks.orgFindUnique, delete: mocks.orgDelete },
    reportSchedule: { findUnique: mocks.scheduleFindUnique, upsert: mocks.scheduleUpsert },
    analyticsSyncJob: {
      create: mocks.syncJobCreate,
      update: mocks.syncJobUpdate,
      findFirst: mocks.syncJobFindFirst,
      findMany: mocks.syncJobFindMany,
      count: mocks.syncJobCount,
      groupBy: mocks.syncJobGroupBy,
    },
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
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    requireFreshSession: mocks.requireFreshSession,
    getSessionUser: mocks.getSessionUser,
  };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, rateLimit: mocks.rateLimit, counterSnapshot: mocks.counterSnapshot };
});
vi.mock("@metricflock/auth/mailer", () => ({ sendMail: mocks.sendMail, mailerMode: () => "smtp" }));
vi.mock("@metricflock/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/jobs")>();
  return { ...actual, enqueue: mocks.enqueue, getQueue: mocks.getQueue };
});
vi.mock("@metricflock/google/tokens", () => ({ revokeConnection: mocks.revokeConnection }));

import { POST as invitePost } from "@/app/api/members/invite/route";
import { PATCH as memberPatch, DELETE as memberDelete } from "@/app/api/members/[id]/route";
import { GET as scheduleGet, PUT as schedulePut } from "@/app/api/reports/schedule/route";
import { POST as syncPost } from "@/app/api/sync/route";
import { POST as requeuePost } from "@/app/api/sync/requeue/route";
import { GET as failedGet } from "@/app/api/sync/failed/route";
import { GET as metricsGet } from "@/app/api/metrics/route";
import { GET as exportGet } from "@/app/api/organization/export/route";
import { DELETE as deleteOrg } from "@/app/api/organization/route";
import { GET as apiKeysGet, POST as apiKeysPost } from "@/app/api/api-keys/route";
import { DELETE as revokeApiKey } from "@/app/api/api-keys/[id]/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const unauth = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
const freshOk = { ok: true as const };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.requireFreshSession.mockResolvedValue(freshOk);
  mocks.getSessionUser.mockResolvedValue(admin);
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  mocks.sendMail.mockResolvedValue(undefined);
  mocks.revokeConnection.mockResolvedValue(undefined);
  mocks.counterSnapshot.mockReturnValue({});
  mocks.tx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      $queryRaw: mocks.txQueryRaw,
      user: { count: mocks.txUserCount, update: mocks.txUserUpdate, delete: mocks.txUserDelete },
      auditLog: { deleteMany: mocks.orgTxAuditDeleteMany },
      organization: { delete: mocks.orgTxOrgDelete },
    }),
  );
  mocks.txQueryRaw.mockResolvedValue([]);
  mocks.orgTxAuditDeleteMany.mockResolvedValue({ count: 0 });
  mocks.orgTxOrgDelete.mockResolvedValue({ id: "org1" });
});

describe("POST /api/members/invite", () => {
  const url = "http://localhost/api/members/invite";
  beforeEach(() => {
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.inviteDeleteMany.mockResolvedValue({ count: 0 });
    mocks.inviteCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "inv1",
      ...data,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }));
    mocks.orgFindUnique.mockResolvedValue({ name: "Org One" });
  });
  it("unauthenticated → 401; rate-limited → 429; invalid input → 400", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await invitePost(jsonReq(url, "POST", { email: "x@example.com" }))).status).toBe(401);
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    expect((await invitePost(jsonReq(url, "POST", { email: "x@example.com" }))).status).toBe(429);
    const bad = await invitePost(jsonReq(url, "POST", { email: "not-an-email" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_input" });
  });
  it("existing member in this org → 409 already_member", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u9", organizationId: "org1" });
    const res = await invitePost(jsonReq(url, "POST", { email: "x@example.com" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "already_member" });
    expect(mocks.inviteCreate).not.toHaveBeenCalled();
  });
  it("valid → 201 with inviteUrl + email + audit; mail failure still succeeds", async () => {
    const res = await invitePost(jsonReq(url, "POST", { email: "New@Example.com", role: "TEAM_ADMIN" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invite).toMatchObject({ email: "new@example.com", role: "TEAM_ADMIN" });
    expect(body.inviteUrl).toMatch(/\/invite\/[a-f0-9]{64}$/);
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "new@example.com", subject: expect.stringContaining("Org One") }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.invited", entityType: "OrganizationInvite", entityId: "inv1" }),
    );
    mocks.sendMail.mockRejectedValueOnce(new Error("smtp down"));
    const res2 = await invitePost(jsonReq(url, "POST", { email: "y@example.com" }));
    expect(res2.status).toBe(201);
  });
  it("user in another org is invited (not already_member); unknown org name falls back", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u9", organizationId: "org2" });
    mocks.orgFindUnique.mockResolvedValue(null);
    const res = await invitePost(jsonReq(url, "POST", { email: "z@example.com" }));
    expect(res.status).toBe(201);
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining("MetricFlock") }),
    );
  });
});

describe("PATCH /api/members/[id]", () => {
  const url = "http://localhost/api/members/u2";
  const target = { id: "u2", role: "TEAM_MEMBER", email: "m@example.com" };
  it("unauthenticated → 401; invalid input → 400; unknown member → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await memberPatch(jsonReq(url, "PATCH", { role: "TEAM_ADMIN" }), ctx("u2"))).status).toBe(401);
    const bad = await memberPatch(jsonReq(url, "PATCH", { role: "NOPE" }), ctx("u2"));
    expect(bad.status).toBe(400);
    mocks.userFindFirst.mockResolvedValue(null);
    expect((await memberPatch(jsonReq(url, "PATCH", { role: "TEAM_ADMIN" }), ctx("u2"))).status).toBe(404);
  });
  it("cannot change own role → 400; non-admin touching SUPER_ADMIN → 403", async () => {
    mocks.userFindFirst.mockResolvedValue({ ...target, id: "u1" });
    const self = await memberPatch(jsonReq(url, "PATCH", { role: "TEAM_ADMIN" }), ctx("u1"));
    expect(self.status).toBe(400);
    expect(await self.json()).toMatchObject({ error: "cannot_change_own_role" });
    mocks.userFindFirst.mockResolvedValue({ ...target, role: "SUPER_ADMIN" });
    mocks.requireApiAuth.mockResolvedValueOnce({ user: { ...admin, role: "TEAM_ADMIN" } });
    const forbidden = await memberPatch(jsonReq(url, "PATCH", { role: "TEAM_MEMBER" }), ctx("u2"));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "forbidden" });
  });
  it("plain role change → 200 + audit; audit failure still 200", async () => {
    mocks.userFindFirst.mockResolvedValue(target);
    mocks.userUpdate.mockResolvedValue({ id: "u2", email: "m@example.com", role: "TEAM_ADMIN" });
    const res = await memberPatch(jsonReq(url, "PATCH", { role: "TEAM_ADMIN" }), ctx("u2"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ member: { role: "TEAM_ADMIN" } });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.role_changed",
        details: expect.objectContaining({ from: "TEAM_MEMBER", to: "TEAM_ADMIN" }),
      }),
    );
    mocks.writeAudit.mockRejectedValueOnce(new Error("audit down"));
    const res2 = await memberPatch(jsonReq(url, "PATCH", { role: "TEAM_ADMIN" }), ctx("u2"));
    expect(res2.status).toBe(200);
  });
  it("demoting the last SUPER_ADMIN → 409; with 2 admins → 200 via locked tx", async () => {
    mocks.userFindFirst.mockResolvedValue({ ...target, role: "SUPER_ADMIN" });
    mocks.txUserCount.mockResolvedValue(1);
    mocks.tx.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: mocks.txQueryRaw,
        user: { count: mocks.txUserCount, update: mocks.txUserUpdate, delete: mocks.txUserDelete },
      }),
    );
    const blocked = await memberPatch(jsonReq(url, "PATCH", { role: "TEAM_MEMBER" }), ctx("u2"));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "last_super_admin" });
    mocks.txUserCount.mockResolvedValue(2);
    mocks.txUserUpdate.mockResolvedValue({ id: "u2", email: "m@example.com", role: "TEAM_MEMBER" });
    mocks.tx.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: mocks.txQueryRaw,
        user: { count: mocks.txUserCount, update: mocks.txUserUpdate, delete: mocks.txUserDelete },
      }),
    );
    const ok = await memberPatch(jsonReq(url, "PATCH", { role: "TEAM_MEMBER" }), ctx("u2"));
    expect(ok.status).toBe(200);
    expect(mocks.txQueryRaw).toHaveBeenCalled();
  });
});

describe("DELETE /api/members/[id]", () => {
  const url = "http://localhost/api/members/u2";
  const target = { id: "u2", role: "TEAM_MEMBER", email: "m@example.com" };
  beforeEach(() => {
    mocks.connCount.mockResolvedValue(0);
    mocks.websiteTransferCount.mockResolvedValue(0);
  });
  it("unauthenticated → 401; unknown member → 404; cannot delete self → 400", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await memberDelete(new NextRequest(url, { method: "DELETE" }), ctx("u2"))).status).toBe(401);
    mocks.userFindFirst.mockResolvedValue(null);
    expect((await memberDelete(new NextRequest(url, { method: "DELETE" }), ctx("u2"))).status).toBe(404);
    mocks.userFindFirst.mockResolvedValue({ ...target, id: "u1" });
    const self = await memberDelete(new NextRequest(url, { method: "DELETE" }), ctx("u1"));
    expect(self.status).toBe(400);
    expect(await self.json()).toMatchObject({ error: "cannot_delete_self" });
  });
  it("non-admin deleting a SUPER_ADMIN → 403; member with dependencies → 409", async () => {
    mocks.userFindFirst.mockResolvedValue({ ...target, role: "SUPER_ADMIN" });
    mocks.requireApiAuth.mockResolvedValueOnce({ user: { ...admin, role: "TEAM_ADMIN" } });
    const forbidden = await memberDelete(new NextRequest(url, { method: "DELETE" }), ctx("u2"));
    expect(forbidden.status).toBe(403);
    mocks.userFindFirst.mockResolvedValue(target);
    mocks.connCount.mockResolvedValue(2);
    mocks.websiteTransferCount.mockResolvedValue(1);
    const deps = await memberDelete(new NextRequest(url, { method: "DELETE" }), ctx("u2"));
    expect(deps.status).toBe(409);
    expect(await deps.json()).toMatchObject({
      error: "member_has_dependencies",
      details: { connections: 2, transfers: 1 },
    });
  });
  it("deleting the last SUPER_ADMIN → 409; otherwise → 200 + audit", async () => {
    mocks.userFindFirst.mockResolvedValue({ ...target, role: "SUPER_ADMIN" });
    mocks.txUserCount.mockResolvedValue(1);
    mocks.tx.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: mocks.txQueryRaw,
        user: { count: mocks.txUserCount, update: mocks.txUserUpdate, delete: mocks.txUserDelete },
      }),
    );
    const blocked = await memberDelete(new NextRequest(url, { method: "DELETE" }), ctx("u2"));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "last_super_admin" });
    mocks.userFindFirst.mockResolvedValue(target);
    mocks.txUserDelete.mockResolvedValue({});
    const res = await memberDelete(new NextRequest(url, { method: "DELETE" }), ctx("u2"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.deleted", entityId: "u2" }),
    );
  });
});

describe("GET /api/reports/schedule", () => {
  it("unauthenticated → 401; no schedule → defaults; with schedule → shaped", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await scheduleGet(new NextRequest("http://localhost/api/reports/schedule"))).status).toBe(401);
    mocks.scheduleFindUnique.mockResolvedValue(null);
    const def = await scheduleGet(new NextRequest("http://localhost/api/reports/schedule"));
    expect(await def.json()).toEqual({
      schedule: { enabled: false, dayOfWeek: 1, hourUtc: 8, recipients: [], lastSentAt: null },
    });
    mocks.scheduleFindUnique.mockResolvedValue({
      enabled: true,
      dayOfWeek: 5,
      hourUtc: 9,
      recipients: ["a@example.com", 42, "b@example.com"],
      lastSentAt: new Date("2026-11-20T08:00:00.000Z"),
    });
    const res = await scheduleGet(new NextRequest("http://localhost/api/reports/schedule"));
    expect(await res.json()).toEqual({
      schedule: {
        enabled: true,
        dayOfWeek: 5,
        hourUtc: 9,
        recipients: ["a@example.com", "b@example.com"],
        lastSentAt: "2026-11-20T08:00:00.000Z",
      },
    });
  });
});

describe("PUT /api/reports/schedule", () => {
  const url = "http://localhost/api/reports/schedule";
  const valid = { enabled: true, dayOfWeek: 1, hourUtc: 8, recipients: ["a@example.com"] };
  beforeEach(() => {
    mocks.scheduleUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: "sched1",
      ...create,
      lastSentAt: null,
    }));
  });
  it("unauthenticated → 401; bad day/hour → 400; too many recipients → 400", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await schedulePut(jsonReq(url, "PUT", valid))).status).toBe(401);
    for (const dayOfWeek of [7, -1, "x"]) {
      const res = await schedulePut(jsonReq(url, "PUT", { ...valid, dayOfWeek }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_day_of_week" });
    }
    for (const hourUtc of [24, -1]) {
      const res = await schedulePut(jsonReq(url, "PUT", { ...valid, hourUtc }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_hour" });
    }
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`);
    const res = await schedulePut(jsonReq(url, "PUT", { ...valid, recipients: many }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "too_many_recipients" });
  });
  it("recipients are trimmed, deduped and invalid entries dropped; valid → 200 + audit", async () => {
    const res = await schedulePut(
      jsonReq(url, "PUT", {
        ...valid,
        recipients: [" a@example.com ", "bad", "a@example.com", "b@example.com", 7, null],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule.recipients).toEqual(["a@example.com", "b@example.com"]);
    expect(mocks.scheduleUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org1" },
        create: expect.objectContaining({ enabled: true, dayOfWeek: 1, hourUtc: 8 }),
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "report.schedule_updated",
        entityType: "ReportSchedule",
        entityId: "sched1",
        details: { enabled: true, dayOfWeek: 1, hourUtc: 8, recipientCount: 2 },
      }),
    );
  });
});

describe("POST /api/sync", () => {
  const url = "http://localhost/api/sync";
  const body = { websiteId: "w1", type: "ga4-historical-sync" };
  beforeEach(() => {
    mocks.websiteFindFirst.mockResolvedValue({ id: "w1", organizationId: "org1", teamId: "t1" });
    mocks.syncJobCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "job-row-1",
      ...data,
    }));
    mocks.enqueue.mockResolvedValue({ id: "ga4-historical-sync:w1:1" });
  });
  it("unauthenticated → 401; forbidden role → 403; invalid input → 400", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await syncPost(jsonReq(url, "POST", body))).status).toBe(401);
    mocks.getSessionUser.mockResolvedValueOnce({ ...admin, role: undefined });
    const forbidden = await syncPost(jsonReq(url, "POST", body));
    expect(forbidden.status).toBe(403);
    const bad = await syncPost(jsonReq(url, "POST", { websiteId: "w1", type: "bogus" }));
    expect(bad.status).toBe(400);
  });
  it("cross-tenant website → 404 (real assertWebsiteAccess finds nothing)", async () => {
    mocks.websiteFindFirst.mockResolvedValueOnce(null);
    const res = await syncPost(jsonReq(url, "POST", body));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found_or_forbidden" });
    expect(mocks.syncJobCreate).not.toHaveBeenCalled();
  });
  it("valid → 200 queued + audit; Redis down → 503 + row marked FAILED", async () => {
    const res = await syncPost(jsonReq(url, "POST", body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", queued: true });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "ga4-historical-sync",
      expect.objectContaining({ websiteId: "w1", syncJobRowId: "job-row-1" }),
      expect.objectContaining({ priority: 1 }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sync.triggered", entityType: "Website", entityId: "w1" }),
    );
    mocks.enqueue.mockResolvedValueOnce(null);
    mocks.syncJobUpdate.mockResolvedValue({});
    const down = await syncPost(jsonReq(url, "POST", body));
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: "queue_unavailable" });
    expect(mocks.syncJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "job-row-1" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });
});

describe("POST /api/sync/requeue", () => {
  const url = "http://localhost/api/sync/requeue";
  const row = { id: "row1", type: "GA4_HISTORICAL", status: "FAILED", websiteId: "w1", payload: { websiteId: "w1" } };
  it("unauthenticated → 401; non-admin → 403; invalid input → 400; unknown job → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await requeuePost(jsonReq(url, "POST", { jobId: "row1" }))).status).toBe(401);
    mocks.requireApiAuth.mockResolvedValueOnce({ user: { ...admin, role: "TEAM_ADMIN" } });
    expect((await requeuePost(jsonReq(url, "POST", { jobId: "row1" }))).status).toBe(403);
    expect((await requeuePost(jsonReq(url, "POST", {}))).status).toBe(400);
    mocks.syncJobFindFirst.mockResolvedValue(null);
    const missing = await requeuePost(jsonReq(url, "POST", { jobId: "row1" }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });
  });
  it("non-FAILED row → 409 invalid_state; unknown type → 422; queue down → 503", async () => {
    mocks.syncJobFindFirst.mockResolvedValue({ ...row, status: "PENDING" });
    const state = await requeuePost(jsonReq(url, "POST", { jobId: "row1" }));
    expect(state.status).toBe(409);
    expect(await state.json()).toMatchObject({ error: "invalid_state", status: "PENDING" });
    mocks.syncJobFindFirst.mockResolvedValue({ ...row, type: "BOGUS" });
    const unknown = await requeuePost(jsonReq(url, "POST", { jobId: "row1" }));
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ error: "unknown_job_type", type: "BOGUS" });
    mocks.syncJobFindFirst.mockResolvedValue(row);
    mocks.enqueue.mockResolvedValueOnce(null);
    const down = await requeuePost(jsonReq(url, "POST", { jobId: "row1" }));
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: "queue_unavailable" });
  });
  it("valid → 200 + row back to PENDING + audit sync.job.requeued", async () => {
    mocks.syncJobFindFirst.mockResolvedValue(row);
    mocks.enqueue.mockResolvedValue({ id: "requeue:row1:123" });
    mocks.syncJobUpdate.mockResolvedValue({});
    const res = await requeuePost(jsonReq(url, "POST", { jobId: "row1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok", jobId: "row1", queue: "ga4-historical-sync" });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "ga4-historical-sync",
      expect.objectContaining({ websiteId: "w1", syncJobRowId: "row1" }),
      expect.objectContaining({ priority: 2 }),
    );
    expect(mocks.syncJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row1" },
        data: expect.objectContaining({ status: "PENDING", externalId: "requeue:row1:123", lastError: null }),
      }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sync.job.requeued", entityType: "AnalyticsSyncJob", entityId: "row1" }),
    );
  });
});

describe("GET /api/sync/failed", () => {
  it("unauthenticated → 401; non-admin → 403; valid → 200 jobs + pagination", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await failedGet(new NextRequest("http://localhost/api/sync/failed"))).status).toBe(401);
    mocks.requireApiAuth.mockResolvedValueOnce({ user: { ...admin, role: "TEAM_ADMIN" } });
    expect((await failedGet(new NextRequest("http://localhost/api/sync/failed"))).status).toBe(403);
    mocks.syncJobCount.mockResolvedValue(2);
    mocks.syncJobFindMany.mockResolvedValue([
      {
        id: "j1",
        websiteId: "w1",
        type: "GA4_HISTORICAL",
        status: "FAILED",
        attempts: 5,
        lastError: "x",
        payload: {},
        updatedAt: new Date(),
      },
    ]);
    const res = await failedGet(new NextRequest("http://localhost/api/sync/failed?limit=10&offset=0"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.pagination).toMatchObject({ total: 2, limit: 10, offset: 0 });
    expect(mocks.syncJobCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "FAILED" }) }),
    );
  });
});

describe("GET /api/metrics", () => {
  const url = "http://localhost/api/metrics";
  beforeEach(() => {
    mocks.syncJobGroupBy.mockResolvedValue([
      { status: "SUCCEEDED", _count: { _all: 8 } },
      { status: "FAILED", _count: { _all: 2 } },
    ]);
    mocks.syncJobFindFirst.mockResolvedValue({ updatedAt: new Date("2026-11-22T10:00:00.000Z") });
    mocks.counterSnapshot.mockReturnValue({ "cache.hit": 80, "cache.stale_hit": 10, "cache.miss": 10 });
    mocks.getQueue.mockReturnValue(null);
  });
  it("unauthenticated → 401; non-admin → 403", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await metricsGet(new NextRequest(url))).status).toBe(401);
    mocks.requireApiAuth.mockResolvedValueOnce({ user: { ...admin, role: "TEAM_ADMIN" } });
    expect((await metricsGet(new NextRequest(url))).status).toBe(403);
  });
  it("valid → 200 with cache hit rate, sync rates, DLQ and disabled queues", async () => {
    const res = await metricsGet(new NextRequest(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cache).toEqual({ hits: 80, staleHits: 10, misses: 10, hitRate: 0.9 });
    expect(body.sync24h).toEqual({ byStatus: { SUCCEEDED: 8, FAILED: 2 }, successRate: 0.8 });
    expect(body.dlq).toEqual({ failed24h: 2, oldestFailedAt: "2026-11-22T10:00:00.000Z" });
    expect(body.queues["ga4-historical-sync"]).toEqual({ disabled: true });
    expect(typeof body.uptimeSeconds).toBe("number");
  });
  it("no lookups → hitRate null; no finished jobs → successRate null; queue counts + errors", async () => {
    mocks.counterSnapshot.mockReturnValue({});
    mocks.syncJobGroupBy.mockResolvedValue([]);
    mocks.syncJobFindFirst.mockResolvedValue(null);
    const failingQueue = { getJobCounts: vi.fn().mockRejectedValue(new Error("down")) };
    const okQueue = { getJobCounts: vi.fn().mockResolvedValue({ waiting: 1, delayed: 0, active: 0, failed: 0 }) };
    mocks.getQueue.mockImplementation((name: string) => (name === "ga4-historical-sync" ? okQueue : failingQueue));
    const res = await metricsGet(new NextRequest(url));
    const body = await res.json();
    expect(body.cache.hitRate).toBeNull();
    expect(body.sync24h.successRate).toBeNull();
    expect(body.dlq).toEqual({ failed24h: 0, oldestFailedAt: null });
    expect(body.queues["ga4-historical-sync"]).toEqual({ waiting: 1, delayed: 0, active: 0, failed: 0 });
    expect(body.queues["adsense-sync"]).toEqual({ error: "unavailable" });
  });
});

describe("GET /api/organization/export", () => {
  it("unauthenticated → 401; valid → attachment JSON + audit organization.exported", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await exportGet(new NextRequest("http://localhost/api/organization/export"))).status).toBe(401);
    mocks.orgFindUnique.mockResolvedValue({ id: "org1", name: "Org One", slug: "org-one", createdAt: new Date() });
    mocks.userFindMany.mockResolvedValue([{ id: "u1", email: "admin@example.com" }]);
    mocks.teamFindMany.mockResolvedValue([]);
    mocks.websiteFindMany.mockResolvedValue([]);
    mocks.connFindMany.mockResolvedValue([]);
    mocks.transferFindMany.mockResolvedValue([]);
    const res = await exportGet(new NextRequest("http://localhost/api/organization/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Content-Disposition")).toContain("metricflock-org-one-export.json");
    const body = await res.json();
    expect(body.organization).toMatchObject({ id: "org1", slug: "org-one" });
    expect(body.members).toHaveLength(1);
    expect(body).not.toHaveProperty("password");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "organization.exported",
        entityType: "Organization",
        entityId: "org1",
        details: { members: 1, websites: 0 },
      }),
    );
  });
});

describe("DELETE /api/organization (remaining branches)", () => {
  const url = "http://localhost/api/organization";
  it("unknown org → 404; slug mismatch → 400", async () => {
    mocks.orgFindUnique.mockResolvedValue(null);
    const missing = await deleteOrg(jsonReq(url, "DELETE", { confirmSlug: "org-one" }));
    expect(missing.status).toBe(404);
    mocks.orgFindUnique.mockResolvedValue({ id: "org1", slug: "org-one", name: "Org One" });
    const mismatch = await deleteOrg(jsonReq(url, "DELETE", { confirmSlug: "wrong" }));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: "confirmation_mismatch" });
  });
  it("valid → revokes each connection best-effort, deletes in tx, 200 deleted", async () => {
    mocks.orgFindUnique.mockResolvedValue({ id: "org1", slug: "org-one", name: "Org One" });
    mocks.connFindMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    mocks.revokeConnection.mockRejectedValueOnce(new Error("revoke failed"));
    const res = await deleteOrg(jsonReq(url, "DELETE", { confirmSlug: "org-one" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(mocks.revokeConnection).toHaveBeenCalledTimes(2);
    expect(mocks.tx).toHaveBeenCalled();
  });
});

describe("GET /api/api-keys", () => {
  it("unauthenticated → 401; valid → 200 keys list", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await apiKeysGet(new NextRequest("http://localhost/api/api-keys"))).status).toBe(401);
    mocks.apiKeyFindMany.mockResolvedValue([
      { id: "k1", name: "CI", prefix: "mf_abc", lastUsedAt: null, revokedAt: null, createdAt: new Date() },
    ]);
    const res = await apiKeysGet(new NextRequest("http://localhost/api/api-keys"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ keys: [{ id: "k1", name: "CI" }] });
  });
});

describe("POST /api/api-keys (remaining branches)", () => {
  const url = "http://localhost/api/api-keys";
  it("invalid name → 400 invalid_name (empty, whitespace, >80 chars)", async () => {
    for (const name of ["", "   ", "x".repeat(81)]) {
      const res = await apiKeysPost(jsonReq(url, "POST", { name }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_name" });
    }
    expect(mocks.apiKeyCreate).not.toHaveBeenCalled();
  });
  it("valid → 201 with one-time secret + audit api_key.created", async () => {
    mocks.apiKeyCreate.mockResolvedValue({ id: "k1", name: "CI", prefix: "mf_abc", createdAt: new Date() });
    const res = await apiKeysPost(jsonReq(url, "POST", { name: "  CI  " }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatchObject({ id: "k1", name: "CI" });
    expect(typeof body.secret).toBe("string");
    expect(body.secret.startsWith("mf_")).toBe(true);
    expect(mocks.apiKeyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "CI", createdById: "u1" }) }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "api_key.created", entityType: "ApiKey", entityId: "k1" }),
    );
  });
});

describe("DELETE /api/api-keys/[id] (remaining branches)", () => {
  it("unknown key → 404 api_key_not_found; already-revoked → 200 without update/audit", async () => {
    mocks.apiKeyFindFirst.mockResolvedValue(null);
    const missing = await revokeApiKey(
      new NextRequest("http://localhost/api/api-keys/k9", { method: "DELETE" }),
      ctx("k9"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "api_key_not_found" });
    mocks.apiKeyFindFirst.mockResolvedValue({ id: "k1", revokedAt: new Date() });
    const res = await revokeApiKey(
      new NextRequest("http://localhost/api/api-keys/k1", { method: "DELETE" }),
      ctx("k1"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.apiKeyUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});
