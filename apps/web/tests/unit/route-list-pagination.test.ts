import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  requireApiAuth: vi.fn(),
  websiteFindMany: vi.fn(),
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
    website: { findMany: mocks.websiteFindMany },
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
    mocks.apiKeyFindMany.mockResolvedValue([]);
  });

  describe("GET /api/v1/websites", () => {
    it("honours limit and offset", async () => {
      const res = await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites?limit=2&offset=1"));
      expect(res.status).toBe(200);
      expect(mocks.websiteFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, skip: 1 }));
      // No new response fields: the shape stays exactly { websites }.
      expect(await res.json()).toEqual({ websites: [] });
    });

    it("keeps the 500 default with no params", async () => {
      const res = await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites"));
      expect(res.status).toBe(200);
      expect(mocks.websiteFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500, skip: 0 }));
      expect(await res.json()).toEqual({ websites: [] });
    });

    it("caps limit at 500 and offset at 10000", async () => {
      await v1WebsitesGet(new NextRequest("http://localhost/api/v1/websites?limit=9999&offset=999999"));
      expect(mocks.websiteFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500, skip: 10000 }));
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
