import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// A-API-15 — organization export is capped per collection (1,000 rows)
// with a `truncated` flag + `truncatedCollections` instead of unbounded
// findMany calls. Pattern follows route-audit.test.ts — mocked Prisma +
// auth.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  findUnique: vi.fn(),
  userFindMany: vi.fn(),
  teamFindMany: vi.fn(),
  websiteFindMany: vi.fn(),
  connectionFindMany: vi.fn(),
  transferFindMany: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    organization: { findUnique: mocks.findUnique },
    user: { findMany: mocks.userFindMany },
    team: { findMany: mocks.teamFindMany },
    website: { findMany: mocks.websiteFindMany },
    googleConnection: { findMany: mocks.connectionFindMany },
    websiteTransfer: { findMany: mocks.transferFindMany },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return { ...actual, requireApiAuth: mocks.requireApiAuth };
});

import { GET } from "@/app/api/organization/export/route";

const admin = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };
const unauth = () => ({ error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
const req = () => new NextRequest("http://localhost:3000/api/organization/export", { method: "GET" });

const org = { id: "org1", name: "Org", slug: "org", createdAt: new Date("2026-01-01T00:00:00.000Z") };
const member = (i: number) => ({
  id: `m${i}`,
  name: `Member ${i}`,
  email: `m${i}@example.com`,
  role: "TEAM_MEMBER",
  emailVerified: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

function seedSmall() {
  mocks.findUnique.mockResolvedValue(org);
  mocks.userFindMany.mockResolvedValue([member(1), member(2)]);
  mocks.teamFindMany.mockResolvedValue([]);
  mocks.websiteFindMany.mockResolvedValue([]);
  mocks.connectionFindMany.mockResolvedValue([]);
  mocks.transferFindMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user: admin });
  mocks.writeAudit.mockResolvedValue(undefined);
  seedSmall();
});

describe("GET /api/organization/export (A-API-15 cap)", () => {
  it("small org: all rows, truncated false", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.members).toHaveLength(2);
    expect(payload.truncated).toBe(false);
    expect(payload.truncatedCollections).toEqual([]);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ truncated: false }),
      }),
    );
  });

  it("over-cap members: capped at 1,000, truncated true, collection named", async () => {
    mocks.userFindMany.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => member(i)));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.members).toHaveLength(1000);
    expect(payload.truncated).toBe(true);
    expect(payload.truncatedCollections).toEqual(["members"]);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ truncated: true }),
      }),
    );
  });

  it("exactly 1,000 members: not truncated", async () => {
    mocks.userFindMany.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => member(i)));
    const res = await GET(req());
    const payload = await res.json();
    expect(payload.members).toHaveLength(1000);
    expect(payload.truncated).toBe(false);
    expect(payload.truncatedCollections).toEqual([]);
  });

  it("over-cap websites: capped, other collections intact", async () => {
    mocks.websiteFindMany.mockResolvedValue(Array.from({ length: 1002 }, (_, i) => ({ id: `w${i}` })));
    const res = await GET(req());
    const payload = await res.json();
    expect(payload.websites).toHaveLength(1000);
    expect(payload.members).toHaveLength(2);
    expect(payload.truncated).toBe(true);
    expect(payload.truncatedCollections).toEqual(["websites"]);
  });

  it("unauthenticated: 401 passthrough", async () => {
    mocks.requireApiAuth.mockResolvedValue(unauth());
    const res = await GET(req());
    expect(res.status).toBe(401);
  });
});
