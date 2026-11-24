import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// A-FE-02 (Stage 1, row 13): the /websites page paginates 50/page like
// the dashboard. The page itself is a server component (not unit-runnable
// in node), so the regression test exercises the underlying list API
// (GET /api/websites), which shares the same bound: 120 websites →
// page 1 returns 50 with total 120, offset 100 (page 3) returns the last
// 20. The page query mirrors this bound (skip/take 50 + count).
const mocks = vi.hoisted(() => ({
  websiteFindMany: vi.fn(),
  websiteCount: vi.fn(),
  requireApiAuth: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: { website: { findMany: mocks.websiteFindMany, count: mocks.websiteCount } },
}));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return {
    ...actual,
    requireApiAuth: mocks.requireApiAuth,
    listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds,
  };
});

import { GET } from "@/app/api/websites/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const site = (i: number) => ({ id: `w${i}`, name: `Site ${i}`, domain: `site${i}.example` });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
  mocks.websiteCount.mockResolvedValue(120);
});

describe("GET /api/websites pagination (A-FE-02)", () => {
  it("page 1 (default) returns 50 of 120 with total 120", async () => {
    mocks.websiteFindMany.mockResolvedValue(Array.from({ length: 50 }, (_, i) => site(i + 1)));
    const res = await GET(new NextRequest("http://localhost/api/websites"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.websites).toHaveLength(50);
    expect(body.pagination).toEqual({ total: 120, limit: 50, offset: 0 });
    expect(mocks.websiteFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 0 }));
    expect(mocks.websiteCount).toHaveBeenCalled();
  });
  it("offset 100 (page 3) returns the last 20 and the pager can reach page 3", async () => {
    mocks.websiteFindMany.mockResolvedValue(Array.from({ length: 20 }, (_, i) => site(101 + i)));
    const res = await GET(new NextRequest("http://localhost/api/websites?limit=50&offset=100"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.websites).toHaveLength(20);
    expect(body.pagination).toEqual({ total: 120, limit: 50, offset: 100 });
    expect(mocks.websiteFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50, skip: 100 }));
    // 120 / 50 = 3 pages: page 3 exists and is not empty.
    expect(Math.ceil(body.pagination.total / body.pagination.limit)).toBe(3);
  });
  it("unauthenticated → 401", async () => {
    mocks.requireApiAuth.mockResolvedValue({
      error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    });
    const res = await GET(new NextRequest("http://localhost/api/websites"));
    expect(res.status).toBe(401);
    expect(mocks.websiteFindMany).not.toHaveBeenCalled();
  });
});
