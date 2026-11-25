import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildCacheKey } from "@metricflock/shared";

// A-WRK-10 regression tests: a >200-website org's weekly report and
// portfolio totals must include ALL sites — the old code silently
// capped both at the first 200, with totals that looked complete.
// The findMany mocks below honour skip/take the way Postgres would,
// so the page counts asserted here are real.
const mocks = vi.hoisted(() => ({
  orgFindUnique: vi.fn(),
  scheduleFindUnique: vi.fn(),
  scheduleUpdateMany: vi.fn(),
  websiteCount: vi.fn(),
  websiteFindMany: vi.fn(),
  healthFindMany: vi.fn(),
  integrationCount: vi.fn(),
  userFindMany: vi.fn(),
  listAccessibleWebsiteIds: vi.fn(),
  sendMail: vi.fn(),
  mailerMode: vi.fn(),
  readSnapshots: vi.fn(),
  getPrimaryIntegrations: vi.fn(),
  window: { startDate: "2026-10-19", endDate: "2026-11-15" },
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    organization: { findUnique: mocks.orgFindUnique },
    reportSchedule: { findUnique: mocks.scheduleFindUnique, updateMany: mocks.scheduleUpdateMany },
    website: { count: mocks.websiteCount, findMany: mocks.websiteFindMany },
    integrationHealth: { findMany: mocks.healthFindMany },
    websiteIntegration: { count: mocks.integrationCount },
    user: { findMany: mocks.userFindMany },
  },
}));
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshots: mocks.readSnapshots }));
vi.mock("@metricflock/auth", () => ({ listAccessibleWebsiteIds: mocks.listAccessibleWebsiteIds }));
vi.mock("@metricflock/auth/mailer", () => ({
  sendMail: mocks.sendMail,
  mailerMode: mocks.mailerMode,
}));
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegrations: mocks.getPrimaryIntegrations }));
vi.mock("@metricflock/google/sync", () => ({
  last28Days: () => ({ ...mocks.window }),
}));

import { sendOrgReport } from "@metricflock/worker/report";
import { loadPortfolio } from "@/lib/portfolio";

const RANGE = "2026-10-19_2026-11-15";

function ga4Key(websiteId: string, propertyId: string) {
  return buildCacheKey({
    organizationId: "org-1",
    websiteId,
    propertyId,
    source: "ga4",
    report: "overview",
    range: RANGE,
  });
}

describe("A-WRK-10 — weekly report includes every website past 200", () => {
  const SITES = Array.from({ length: 250 }, (_, i) => ({ id: `w${i}` }));

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.orgFindUnique.mockResolvedValue({ id: "org-1", name: "Acme" });
    mocks.scheduleFindUnique.mockResolvedValue({ organizationId: "org-1", recipients: ["a@example.com"] });
    mocks.scheduleUpdateMany.mockResolvedValue({ count: 1 });
    mocks.healthFindMany.mockResolvedValue([]);
    mocks.integrationCount.mockResolvedValue(0);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.mailerMode.mockReturnValue("smtp");
    mocks.sendMail.mockResolvedValue(undefined);
    mocks.websiteFindMany.mockImplementation(async (args: { skip?: number; take?: number }) =>
      SITES.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 200)),
    );
    // Every site has a GA4 mapping; nothing for SC/AdSense.
    mocks.getPrimaryIntegrations.mockImplementation(async (websiteIds: string[], providers: string[]) => {
      const out = new Map<string, Map<string, { externalId: string }>>();
      for (const id of websiteIds) {
        const perSite = new Map<string, { externalId: string }>();
        for (const provider of providers) {
          if (provider === "GA4") perSite.set(provider, { externalId: `ga-${id}` });
        }
        if (perSite.size > 0) out.set(id, perSite);
      }
      return out;
    });
    const snapshots = new Map<string, unknown>();
    for (const site of SITES) {
      snapshots.set(ga4Key(site.id, `ga-${site.id}`), {
        payload: {
          summary: { sessions: 10, activeUsers: 8, screenPageViews: 20, engagedSessions: 5, keyEvents: 1 },
        },
      });
    }
    mocks.readSnapshots.mockImplementation(async (keys: string[]) => {
      const out = new Map<string, unknown>();
      for (const key of keys) if (snapshots.has(key)) out.set(key, snapshots.get(key));
      return out;
    });
  });

  it("totals 250 websites (10 sessions each) instead of silently capping at 200", async () => {
    const result = await sendOrgReport("org-1");
    expect(result.status).toBe("ok");
    const mail = mocks.sendMail.mock.calls[0][0] as { text: string };
    // 250 × 10, not 200 × 10 — the old take: 200 would print 2,000.
    expect(mail.text).toContain("Sessions: 2,500");
    expect(mail.text).toContain("250 websites with data");
    // Two pages: 200 + 50, in createdAt order.
    expect(mocks.websiteFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.websiteFindMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 200 });
    expect(mocks.websiteFindMany.mock.calls[1][0]).toMatchObject({ skip: 200, take: 200 });
    // One batched primaries + one batched snapshots call per page for GA4.
    const ga4Primaries = mocks.getPrimaryIntegrations.mock.calls.filter((c) => (c[1] as string[]).includes("GA4"));
    expect(ga4Primaries).toHaveLength(2);
    expect((ga4Primaries[0]![0] as string[]).length).toBe(200);
    expect((ga4Primaries[1]![0] as string[]).length).toBe(50);
    const ga4SnapshotKeys = mocks.readSnapshots.mock.calls
      .map((c) => c[0] as string[])
      .filter((keys) => keys.some((k) => k.includes("ga4")));
    expect(ga4SnapshotKeys).toHaveLength(2);
    expect(ga4SnapshotKeys[0]).toHaveLength(200);
    expect(ga4SnapshotKeys[1]).toHaveLength(50);
  });
});

describe("A-WRK-10 — loadPortfolio totals include every website past 200", () => {
  const user = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN" };
  const SITES = Array.from({ length: 250 }, (_, i) => ({
    id: `w${i}`,
    name: `Site ${i}`,
    domain: `site${i}.example`,
  }));
  const opts = {
    provider: "GA4" as const,
    source: "ga4",
    report: "overview",
    startDate: "2026-10-26",
    endDate: "2026-11-22",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAccessibleWebsiteIds.mockResolvedValue(null);
    mocks.websiteCount.mockResolvedValue(250);
    mocks.websiteFindMany.mockImplementation(async (args: { skip?: number; take?: number }) =>
      SITES.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 200)),
    );
    mocks.getPrimaryIntegrations.mockImplementation(async (websiteIds: string[], providers: string[]) => {
      const out = new Map<string, Map<string, { externalId: string }>>();
      for (const id of websiteIds) {
        out.set(id, new Map(providers.map((p) => [p, { externalId: `properties/${id}` }])));
      }
      return out;
    });
    mocks.readSnapshots.mockImplementation(async (keys: string[]) => {
      const out = new Map<string, unknown>();
      for (const key of keys) {
        out.set(key, {
          payload: { summary: { sessions: 1000, engagedSessions: 500, keyEvents: 10 } },
          expiresAt: new Date(Date.now() + 60_000),
          updatedAt: new Date("2026-11-22T00:00:00Z"),
        });
      }
      return out;
    });
  });

  it("totals 250 websites instead of silently capping at 200, with no truncation flag", async () => {
    const result = await loadPortfolio(user, opts);
    // 250 × 1000, not 200 × 1000 — the old default limit would total 200,000.
    expect(result.totals?.sessions).toBe(250000);
    expect(result.websites).toHaveLength(250);
    expect(result.websiteCount).toBe(250);
    expect(result.truncated).toBe(false);
    // Two pages of the website list, one batched primaries + one
    // batched snapshots call per page.
    expect(mocks.websiteFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.websiteFindMany.mock.calls[1][0]).toMatchObject({ skip: 200, take: 200 });
    expect(mocks.getPrimaryIntegrations).toHaveBeenCalledTimes(2);
    expect((mocks.getPrimaryIntegrations.mock.calls[0]![0] as string[]).length).toBe(200);
    expect((mocks.getPrimaryIntegrations.mock.calls[1]![0] as string[]).length).toBe(50);
    expect(mocks.readSnapshots).toHaveBeenCalledTimes(2);
    expect((mocks.readSnapshots.mock.calls[0]![0] as string[]).length).toBe(200);
    expect((mocks.readSnapshots.mock.calls[1]![0] as string[]).length).toBe(50);
  });
});
