import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  requireApiAuth: vi.fn(),
  websiteFindMany: vi.fn(),
  websiteCount: vi.fn(),
  apiKeyFindMany: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/lib/api-key-auth", () => ({ requireApiKey: mocks.requireApiKey }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return { ...actual, requireApiAuth: mocks.requireApiAuth };
});
vi.mock("@metricflock/db", () => ({
  prisma: {
    website: { findMany: mocks.websiteFindMany, count: mocks.websiteCount },
    apiKey: { findMany: mocks.apiKeyFindMany },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: mocks.writeAudit }));

import { GET as v1WebsitesGet } from "@/app/api/v1/websites/route";
import { GET as apiKeysGet } from "@/app/api/api-keys/route";

// A-API-09: v1 websites and api-keys hard-coded their takes (500 / 100)
// with no pagination params at all; both now honour limit/offset via
// parsePagination, keeping their old takes as the defaults.
describe("list pagination (A-API-09)", () => {
  const authedKey = {
    organizationId: "org1",
    user: { id: "u1", organizationId: "org1", role: "SUPER_ADMIN" },
  };
  const authedSession = { user: { id: "u1", organizationId: "org1", role: "SUPER_ADMIN" } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiKey.mockResolvedValue(authedKey);
    mocks.requireApiAuth.mockResolvedValue(authedSession);
    mocks.websiteFindMany.mockResolvedValue([]);
    mocks.websiteCount.mockResolvedValue(0);
    mocks.apiKeyFindMany.mockResolvedValue([]);
  });

  describe("GET /api/v1/websites", () => {
    it("honours limit and offset", async () => {
      const res = await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites?limit=2&offset=1"));
      expect(res.status).toBe(200);
      expect(mocks.websiteFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, skip: 1 }));
      // A-API-16: the list key stays, pagination + truncated are added.
      expect(await res.json()).toEqual({
        websites: [],
        pagination: { total: 0, limit: 2, offset: 1 },
        truncated: false,
      });
    });

    it("keeps the 500 default with no params", async () => {
      const res = await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites"));
      expect(res.status).toBe(200);
      expect(mocks.websiteFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500, skip: 0 }));
      expect(await res.json()).toEqual({
        websites: [],
        pagination: { total: 0, limit: 500, offset: 0 },
        truncated: false,
      });
    });

    it("caps limit at 500 and offset at 10000", async () => {
      await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites?limit=9999&offset=999999"));
      expect(mocks.websiteFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500, skip: 10000 }));
    });

    // A-API-16: the old response was exactly { websites } — an org with
    // >500 websites got a silently incomplete list with no way to tell.
    // The count is org-scoped with the same `where` as the list.
    it("reports total and truncated when the org has more than 500 websites", async () => {
      const page = Array.from({ length: 500 }, (_, i) => ({ id: `w${i}` }));
      mocks.websiteFindMany.mockResolvedValue(page);
      mocks.websiteCount.mockResolvedValue(501);
      const res = await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.websites).toHaveLength(500);
      expect(body.pagination).toEqual({ total: 501, limit: 500, offset: 0 });
      expect(body.truncated).toBe(true);
      expect(mocks.websiteCount).toHaveBeenCalledWith({ where: { organizationId: "org1" } });
    });

    it("is not truncated when the page holds the whole org", async () => {
      mocks.websiteFindMany.mockResolvedValue([{ id: "w0" }, { id: "w1" }]);
      mocks.websiteCount.mockResolvedValue(2);
      const res = await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites"));
      const body = await res.json();
      expect(body.pagination).toEqual({ total: 2, limit: 500, offset: 0 });
      expect(body.truncated).toBe(false);
    });

    it("is truncated on a middle page and not on the last page", async () => {
      mocks.websiteFindMany.mockResolvedValue([{ id: "w1" }, { id: "w2" }]);
      mocks.websiteCount.mockResolvedValue(5);
      const middle = await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites?limit=2&offset=1"));
      expect((await middle.json()).truncated).toBe(true);

      mocks.websiteFindMany.mockResolvedValue([{ id: "w4" }]);
      const last = await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites?limit=2&offset=4"));
      const lastBody = await last.json();
      expect(lastBody.pagination).toEqual({ total: 5, limit: 2, offset: 4 });
      expect(lastBody.truncated).toBe(false);
    });
  });

  describe("GET /api/api-keys", () => {
    it("honours limit and offset", async () => {
      const res = await apiKeysGet(new NextRequest("http://localhost/api/api-keys?limit=2&offset=1"));
      expect(res.status).toBe(200);
      expect(mocks.apiKeyFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, skip: 1 }));
      // No new response fields: the shape stays exactly { keys }.
      expect(await res.json()).toEqual({ keys: [] });
    });

    it("keeps the 100 default with no params", async () => {
      const res = await apiKeysGet(new NextRequest("http://localhost/api/api-keys"));
      expect(res.status).toBe(200);
      expect(mocks.apiKeyFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100, skip: 0 }));
      expect(await res.json()).toEqual({ keys: [] });
    });
  });
});
