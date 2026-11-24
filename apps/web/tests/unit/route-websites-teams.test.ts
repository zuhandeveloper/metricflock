import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Coverage-gap closure: websites + teams routes. Pattern follows
// routes-v1-analytics.test.ts — mocked Prisma + auth helpers, each
// handler: unauthenticated → 401, cross-tenant → 404, valid → 200
// shape, plus invalid-input and error-path cases.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  assertWebsiteAccess: vi.fn(),
  assertWebsiteManageAccess: vi.fn(),
  assertTeamAccess: vi.fn(),
  assertTeamManageAccess: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  writeAudit: vi.fn(),
  websiteFindMany: vi.fn(),
  websiteFindFirst: vi.fn(),
  websiteFindUnique: vi.fn(),
  websiteCount: vi.fn(),
  websiteCreate: vi.fn(),
  websiteUpdate: vi.fn(),
  websiteDelete: vi.fn(),
  websiteUpdateMany: vi.fn(),
  teamFindMany: vi.fn(),
  teamFindFirst: vi.fn(),
  teamCount: vi.fn(),
  teamCreate: vi.fn(),
  teamUpdate: vi.fn(),
  teamDelete: vi.fn(),
  teamMemberFindFirst: vi.fn(),
  teamMemberCount: vi.fn(),
  teamMemberUpsert: vi.fn(),
  teamMemberDeleteMany: vi.fn(),
  userFindFirst: vi.fn(),
  assignmentUpsert: vi.fn(),
  assignmentDeleteMany: vi.fn(),
  txTeamFindFirst: vi.fn(),
  txWebsiteUpdate: vi.fn(),
  tx: vi.fn(),
  invalidateWebsiteCache: vi.fn(),
  invalidateWebsiteSnapshots: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    website: {
      findMany: mocks.websiteFindMany,
      findFirst: mocks.websiteFindFirst,
      findUnique: mocks.websiteFindUnique,
      count: mocks.websiteCount,
      create: mocks.websiteCreate,
      update: mocks.websiteUpdate,
      delete: mocks.websiteDelete,
      updateMany: mocks.websiteUpdateMany,
    },
    websiteAssignment: { upsert: mocks.assignmentUpsert, deleteMany: mocks.assignmentDeleteMany },
    team: {
      findMany: mocks.teamFindMany,
      findFirst: mocks.teamFindFirst,
      count: mocks.teamCount,
      create: mocks.teamCreate,
      update: mocks.teamUpdate,
      delete: mocks.teamDelete,
    },
    teamMember: {
      findFirst: mocks.teamMemberFindFirst,
      count: mocks.teamMemberCount,
      upsert: mocks.teamMemberUpsert,
      deleteMany: mocks.teamMemberDeleteMany,
    },
    user: { findFirst: mocks.userFindFirst },
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
    assertWebsiteAccess: mocks.assertWebsiteAccess,
    assertWebsiteManageAccess: mocks.assertWebsiteManageAccess,
    assertTeamAccess: mocks.assertTeamAccess,
    assertTeamManageAccess: mocks.assertTeamManageAccess,
    listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds,
  };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, invalidateWebsiteCache: mocks.invalidateWebsiteCache };
});

import { GET as websitesGet, POST as websitesPost } from "@/app/api/websites/route";
import { GET as websiteGet, PATCH as websitePatch, DELETE as websiteDelete } from "@/app/api/websites/[id]/route";
import { POST as assignPost } from "@/app/api/websites/[id]/assign/route";
import { GET as teamsGet, POST as teamsPost } from "@/app/api/teams/route";
import { PATCH as teamPatch, DELETE as teamDelete } from "@/app/api/teams/[id]/route";
import { POST as teamMembersPost } from "@/app/api/teams/[id]/members/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const unauth = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonReq = (url: string, method: string, body: unknown) =>
  new NextRequest(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const website = { id: "w1", organizationId: "org1", teamId: "t1", name: "Site", domain: "site.example" };
const team = { id: "t1", organizationId: "org1", name: "Team One", slug: "team-one" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.assertWebsiteAccess.mockResolvedValue(website);
  mocks.assertWebsiteManageAccess.mockResolvedValue(website);
  mocks.assertTeamAccess.mockResolvedValue(team);
  mocks.assertTeamManageAccess.mockResolvedValue(team);
  mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
  mocks.writeAudit.mockResolvedValue(undefined);
  mocks.invalidateWebsiteCache.mockResolvedValue(undefined);
  mocks.invalidateWebsiteSnapshots.mockResolvedValue(undefined);
  mocks.tx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      team: { findFirst: mocks.txTeamFindFirst },
      website: { update: mocks.txWebsiteUpdate },
    }),
  );
  mocks.txTeamFindFirst.mockResolvedValue({ id: "t1" });
  mocks.txWebsiteUpdate.mockImplementation(async ({ data }: { data: unknown }) => ({
    ...website,
    ...(data as object),
  }));
});

describe("GET /api/websites", () => {
  it("unauthenticated → 401", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await websitesGet(new NextRequest("http://localhost/api/websites"))).status).toBe(401);
  });
  it("valid → 200 org-scoped list with pagination", async () => {
    mocks.websiteFindMany.mockResolvedValue([website]);
    mocks.websiteCount.mockResolvedValue(1);
    const res = await websitesGet(new NextRequest("http://localhost/api/websites?q=site&status=ACTIVE"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ websites: [{ id: "w1" }], pagination: { total: 1, limit: 50, offset: 0 } });
    expect(mocks.websiteFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: "org1" }) }),
    );
  });
  it("restricted user → where clause limits to accessible ids", async () => {
    mocks.listAccessibleWebsiteIds.mockResolvedValue(["w1", "w2"]);
    mocks.websiteFindMany.mockResolvedValue([]);
    mocks.websiteCount.mockResolvedValue(0);
    await websitesGet(new NextRequest("http://localhost/api/websites"));
    expect(mocks.websiteFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["w1", "w2"] } }) }),
    );
  });
});

describe("POST /api/websites", () => {
  const body = { name: "New", domain: "new.example", url: "https://new.example" };
  it("unauthenticated → 401; invalid input → 400", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await websitesPost(jsonReq("http://localhost/api/websites", "POST", body))).status).toBe(401);
    const bad = await websitesPost(jsonReq("http://localhost/api/websites", "POST", { name: "", domain: "x" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_input" });
  });
  it("unknown destination team → 404 team_not_found", async () => {
    mocks.assertTeamManageAccess.mockRejectedValueOnce(new Error("NOPE"));
    const res = await websitesPost(jsonReq("http://localhost/api/websites", "POST", { ...body, teamId: "t9" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "team_not_found" });
  });
  it("duplicate domain → 409 domain_taken", async () => {
    mocks.websiteCreate.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await websitesPost(jsonReq("http://localhost/api/websites", "POST", body));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "domain_taken" });
  });
  it("valid → 201 + audit website.created", async () => {
    mocks.websiteCreate.mockResolvedValue({ ...website, id: "w2", name: "New", domain: "new.example" });
    const res = await websitesPost(jsonReq("http://localhost/api/websites", "POST", body));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ website: { id: "w2" } });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "website.created", entityType: "Website", entityId: "w2" }),
    );
  });
});

describe("GET /api/websites/[id]", () => {
  it("unauthenticated → 401; cross-tenant → 404; valid → 200 full website", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await websiteGet(new NextRequest("http://localhost/api/websites/w1"), ctx("w1"))).status).toBe(401);
    mocks.assertWebsiteAccess.mockRejectedValueOnce(new Error("NOT_FOUND_OR_FORBIDDEN"));
    const cross = await websiteGet(new NextRequest("http://localhost/api/websites/w9"), ctx("w9"));
    expect(cross.status).toBe(404);
    expect(await cross.json()).toMatchObject({ error: "not_found_or_forbidden" });
    mocks.websiteFindUnique.mockResolvedValue({
      ...website,
      team: team,
      assignments: [],
      integrations: [],
      transfers: [],
    });
    const res = await websiteGet(new NextRequest("http://localhost/api/websites/w1"), ctx("w1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ website: { id: "w1" } });
    expect(mocks.websiteFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "w1" }, include: expect.objectContaining({ team: true }) }),
    );
  });
});

describe("PATCH /api/websites/[id]", () => {
  const body = { name: "Renamed", domain: "site.example", url: "https://site.example" };
  it("unauthenticated → 401; view-only user → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await websitePatch(jsonReq("http://localhost/api/websites/w1", "PATCH", body), ctx("w1"))).status).toBe(
      401,
    );
    mocks.assertWebsiteManageAccess.mockRejectedValueOnce(new Error("NOPE"));
    expect((await websitePatch(jsonReq("http://localhost/api/websites/w1", "PATCH", body), ctx("w1"))).status).toBe(
      404,
    );
  });
  it("invalid input → 400", async () => {
    const res = await websitePatch(jsonReq("http://localhost/api/websites/w1", "PATCH", { domain: "x" }), ctx("w1"));
    expect(res.status).toBe(400);
  });
  it("move to unmanageable team → 404 team_not_found", async () => {
    mocks.assertTeamManageAccess.mockRejectedValueOnce(new Error("NOPE"));
    const res = await websitePatch(
      jsonReq("http://localhost/api/websites/w1", "PATCH", { ...body, teamId: "t9" }),
      ctx("w1"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "team_not_found" });
  });
  it("destination team vanished inside tx → 404 team_not_found", async () => {
    mocks.txTeamFindFirst.mockResolvedValueOnce(null);
    mocks.tx.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ team: { findFirst: mocks.txTeamFindFirst }, website: { update: mocks.txWebsiteUpdate } }),
    );
    const res = await websitePatch(
      jsonReq("http://localhost/api/websites/w1", "PATCH", { ...body, teamId: "t2" }),
      ctx("w1"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "team_not_found" });
  });
  it("duplicate domain in tx → 409 domain_taken; other tx error → 500 internal_error", async () => {
    mocks.tx.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const dup = await websitePatch(jsonReq("http://localhost/api/websites/w1", "PATCH", body), ctx("w1"));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "domain_taken" });
    mocks.tx.mockRejectedValueOnce(new Error("boom"));
    const err = await websitePatch(jsonReq("http://localhost/api/websites/w1", "PATCH", body), ctx("w1"));
    expect(err.status).toBe(500);
    expect(await err.json()).toMatchObject({ error: "internal_error" });
  });
  it("valid → 200 + audit website.updated", async () => {
    const res = await websitePatch(jsonReq("http://localhost/api/websites/w1", "PATCH", body), ctx("w1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ website: { name: "Renamed" } });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "website.updated", entityType: "Website", entityId: "w1" }),
    );
  });
});

describe("DELETE /api/websites/[id]", () => {
  it("unauthenticated → 401; cross-tenant → 404; valid → 200 + invalidates cache/snapshots", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect(
      (await websiteDelete(new NextRequest("http://localhost/api/websites/w1", { method: "DELETE" }), ctx("w1")))
        .status,
    ).toBe(401);
    mocks.assertWebsiteManageAccess.mockRejectedValueOnce(new Error("NOPE"));
    expect(
      (await websiteDelete(new NextRequest("http://localhost/api/websites/w1", { method: "DELETE" }), ctx("w1")))
        .status,
    ).toBe(404);
    mocks.websiteDelete.mockResolvedValue(website);
    const res = await websiteDelete(
      new NextRequest("http://localhost/api/websites/w1", { method: "DELETE" }),
      ctx("w1"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "website.deleted", entityId: "w1" }),
    );
    expect(mocks.invalidateWebsiteCache).toHaveBeenCalledWith("org1", "w1");
    expect(mocks.invalidateWebsiteSnapshots).toHaveBeenCalledWith("w1");
  });
});

describe("POST /api/websites/[id]/assign", () => {
  it("unauthenticated → 401; cross-tenant → 404; invalid input → 400; unknown user → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    const url = "http://localhost/api/websites/w1/assign";
    expect((await assignPost(jsonReq(url, "POST", { userId: "u2" }), ctx("w1"))).status).toBe(401);
    mocks.assertWebsiteManageAccess.mockRejectedValueOnce(new Error("NOPE"));
    expect((await assignPost(jsonReq(url, "POST", { userId: "u2" }), ctx("w1"))).status).toBe(404);
    expect((await assignPost(jsonReq(url, "POST", {}), ctx("w1"))).status).toBe(400);
    mocks.userFindFirst.mockResolvedValue(null);
    const missing = await assignPost(jsonReq(url, "POST", { userId: "u2" }), ctx("w1"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "user_not_found" });
  });
  it("assign → 200 + audit website.assign + invalidates", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", organizationId: "org1" });
    mocks.assignmentUpsert.mockResolvedValue({});
    const res = await assignPost(
      jsonReq("http://localhost/api/websites/w1/assign", "POST", { userId: "u2" }),
      ctx("w1"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "website.assign", details: { userId: "u2" } }),
    );
    expect(mocks.invalidateWebsiteCache).toHaveBeenCalledWith("org1", "w1");
  });
  it("remove → 200 + audit website.remove", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", organizationId: "org1" });
    mocks.assignmentDeleteMany.mockResolvedValue({ count: 1 });
    const res = await assignPost(
      jsonReq("http://localhost/api/websites/w1/assign", "POST", { userId: "u2", action: "remove" }),
      ctx("w1"),
    );
    expect(res.status).toBe(200);
    expect(mocks.assignmentDeleteMany).toHaveBeenCalledWith({ where: { websiteId: "w1", userId: "u2" } });
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "website.remove" }));
  });
});

describe("GET /api/teams", () => {
  it("unauthenticated → 401; valid → 200 list with counts + pagination", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await teamsGet(new NextRequest("http://localhost/api/teams"))).status).toBe(401);
    mocks.teamFindMany.mockResolvedValue([team]);
    mocks.teamCount.mockResolvedValue(1);
    const res = await teamsGet(new NextRequest("http://localhost/api/teams?limit=5&offset=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ teams: [{ id: "t1" }], pagination: { total: 1, limit: 5, offset: 10 } });
  });
});

describe("POST /api/teams", () => {
  it("unauthenticated → 401; invalid input → 400 (bad slug)", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await teamsPost(jsonReq("http://localhost/api/teams", "POST", { name: "T", slug: "t" }))).status).toBe(401);
    const bad = await teamsPost(jsonReq("http://localhost/api/teams", "POST", { name: "T", slug: "Bad Slug!" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_input" });
  });
  it("valid → 201 + audit team.created", async () => {
    mocks.teamCreate.mockResolvedValue(team);
    const res = await teamsPost(jsonReq("http://localhost/api/teams", "POST", { name: "Team One", slug: "team-one" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ team: { id: "t1" } });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "team.created", entityType: "Team", entityId: "t1" }),
    );
  });
});

describe("PATCH /api/teams/[id]", () => {
  it("unauthenticated → 401; cross-tenant → 404; invalid input → 400; valid → 200", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    const url = "http://localhost/api/teams/t1";
    expect((await teamPatch(jsonReq(url, "PATCH", { name: "X" }), ctx("t1"))).status).toBe(401);
    mocks.assertTeamAccess.mockRejectedValueOnce(new Error("NOPE"));
    expect((await teamPatch(jsonReq(url, "PATCH", { name: "X" }), ctx("t1"))).status).toBe(404);
    const bad = await teamPatch(jsonReq(url, "PATCH", { slug: "Bad Slug!" }), ctx("t1"));
    expect(bad.status).toBe(400);
    mocks.teamUpdate.mockResolvedValue({ ...team, name: "Renamed" });
    const res = await teamPatch(jsonReq(url, "PATCH", { name: "Renamed" }), ctx("t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ team: { name: "Renamed" } });
  });
});

describe("DELETE /api/teams/[id]", () => {
  it("unauthenticated → 401; cross-tenant → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    const req = new NextRequest("http://localhost/api/teams/t1", { method: "DELETE" });
    expect((await teamDelete(req, ctx("t1"))).status).toBe(401);
    mocks.assertTeamAccess.mockRejectedValueOnce(new Error("NOPE"));
    expect(
      (await teamDelete(new NextRequest("http://localhost/api/teams/t1", { method: "DELETE" }), ctx("t1"))).status,
    ).toBe(404);
  });
  it("team with websites → 409 team_has_websites", async () => {
    mocks.websiteCount.mockResolvedValue(3);
    const res = await teamDelete(new NextRequest("http://localhost/api/teams/t1", { method: "DELETE" }), ctx("t1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "team_has_websites", websites: 3 });
    expect(mocks.teamDelete).not.toHaveBeenCalled();
  });
  it("empty team → 200 + audit team.deleted", async () => {
    mocks.websiteCount.mockResolvedValue(0);
    mocks.teamDelete.mockResolvedValue(team);
    const res = await teamDelete(new NextRequest("http://localhost/api/teams/t1", { method: "DELETE" }), ctx("t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "team.deleted", entityId: "t1", details: { name: "Team One" } }),
    );
  });
});

describe("POST /api/teams/[id]/members", () => {
  const url = "http://localhost/api/teams/t1/members";
  it("unauthenticated → 401; cross-tenant → 404; invalid input → 400; unknown user → 404", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await teamMembersPost(jsonReq(url, "POST", { userId: "u2" }), ctx("t1"))).status).toBe(401);
    mocks.assertTeamAccess.mockRejectedValueOnce(new Error("NOPE"));
    expect((await teamMembersPost(jsonReq(url, "POST", { userId: "u2" }), ctx("t1"))).status).toBe(404);
    expect((await teamMembersPost(jsonReq(url, "POST", {}), ctx("t1"))).status).toBe(400);
    mocks.userFindFirst.mockResolvedValue(null);
    const missing = await teamMembersPost(jsonReq(url, "POST", { userId: "u2" }), ctx("t1"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "user_not_found" });
  });
  it("add new member → 200 + upsert + audit team.member.add", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", organizationId: "org1" });
    mocks.teamMemberFindFirst.mockResolvedValue(null);
    mocks.teamMemberUpsert.mockResolvedValue({});
    const res = await teamMembersPost(jsonReq(url, "POST", { userId: "u2", isAdmin: true }), ctx("t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(mocks.teamMemberUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ teamId: "t1", userId: "u2", isAdmin: true }) }),
    );
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "team.member.add", entityType: "Team", entityId: "t1" }),
    );
  });
  it("demoting the last admin → 409 last_admin; with 2 admins → 200", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", organizationId: "org1" });
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true });
    mocks.teamMemberCount.mockResolvedValue(1);
    const blocked = await teamMembersPost(jsonReq(url, "POST", { userId: "u2", isAdmin: false }), ctx("t1"));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "last_admin" });
    mocks.teamMemberCount.mockResolvedValue(2);
    mocks.teamMemberUpsert.mockResolvedValue({});
    const ok = await teamMembersPost(jsonReq(url, "POST", { userId: "u2", isAdmin: false }), ctx("t1"));
    expect(ok.status).toBe(200);
  });
  it("remove non-admin → 200 + deleteMany + audit team.member.remove", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", organizationId: "org1" });
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: false });
    mocks.teamMemberDeleteMany.mockResolvedValue({ count: 1 });
    const res = await teamMembersPost(jsonReq(url, "POST", { userId: "u2", action: "remove" }), ctx("t1"));
    expect(res.status).toBe(200);
    expect(mocks.teamMemberDeleteMany).toHaveBeenCalledWith({ where: { teamId: "t1", userId: "u2" } });
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "team.member.remove" }));
  });
  it("remove the last admin → 409 last_admin", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u2", organizationId: "org1" });
    mocks.teamMemberFindFirst.mockResolvedValue({ isAdmin: true });
    mocks.teamMemberCount.mockResolvedValue(1);
    const res = await teamMembersPost(jsonReq(url, "POST", { userId: "u2", action: "remove" }), ctx("t1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "last_admin" });
  });
});
