import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// A-API-12 — programmatic audit access: `GET /api/audit` behind
// `audit.view`. Mirrors the SUPER_ADMIN-gated audit page exactly (same
// organization filter, newest-first order, actor email), paginated via
// parsePagination. Pattern follows route-websites-teams.test.ts — mocked
// Prisma + auth.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  auditFindMany: vi.fn(),
  auditCount: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    auditLog: { findMany: mocks.auditFindMany, count: mocks.auditCount },
  },
}));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return { ...actual, requireApiAuth: mocks.requireApiAuth };
});

import { GET } from "@/app/api/audit/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const unauth = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
const forbidden = () => ({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
const req = (url: string) => new NextRequest(url, { method: "GET" });

const rows = [
  {
    id: "a2",
    action: "auth.sign_in",
    entityType: null,
    entityId: null,
    details: null,
    ipAddress: "127.0.0.1",
    requestId: "r2",
    createdAt: new Date("2026-11-25T05:00:00.000Z"),
    actor: { email: "admin@example.com" },
  },
  {
    id: "a1",
    action: "team.created",
    entityType: "Team",
    entityId: "t1",
    details: { name: "Team A" },
    ipAddress: null,
    requestId: "r1",
    createdAt: new Date("2026-11-25T04:00:00.000Z"),
    actor: { email: "admin@example.com" },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.auditFindMany.mockResolvedValue(rows);
  mocks.auditCount.mockResolvedValue(2);
});

describe("GET /api/audit", () => {
  it("unauthenticated → 401; without audit.view → 403", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(unauth());
    expect((await GET(req("http://localhost/api/audit"))).status).toBe(401);
    mocks.requireApiAuth.mockResolvedValueOnce(forbidden());
    expect((await GET(req("http://localhost/api/audit"))).status).toBe(403);
  });

  it("returns the org log newest-first with actor email + pagination", async () => {
    const res = await GET(req("http://localhost/api/audit"));
    expect(res.status).toBe(200);
    // Same scoping as the audit page: org filter, newest first, actor
    // email included; default limit mirrors the page's take: 100.
    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: { organizationId: "org1" },
      include: { actor: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
      skip: 0,
    });
    expect(mocks.auditCount).toHaveBeenCalledWith({ where: { organizationId: "org1" } });
    const body = await res.json();
    expect(body.logs).toHaveLength(2);
    expect(body.logs[0].action).toBe("auth.sign_in");
    expect(body.logs[0].actor.email).toBe("admin@example.com");
    expect(body.pagination).toEqual({ total: 2, limit: 100, offset: 0 });
  });

  it("honours limit/offset", async () => {
    const res = await GET(req("http://localhost/api/audit?limit=1&offset=1"));
    expect(res.status).toBe(200);
    expect(mocks.auditFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1, skip: 1 }));
    expect(await res.json()).toMatchObject({ pagination: { total: 2, limit: 1, offset: 1 } });
  });
});
