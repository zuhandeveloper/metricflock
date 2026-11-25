import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// A-COV-10 — barrel mocks can hide real wiring regressions.
//
// The existing loader tests (portfolio.test.ts, insights-loader.test.ts,
// loaders-query-count.test.ts) replace `@metricflock/db`,
// `@metricflock/db/snapshots`, `@metricflock/auth` and
// `@metricflock/google/client` with hand-written stubs. Those stubs can
// drift from the real modules: a loader that started calling a Prisma
// method the stub does not provide (or a batch helper that changed its
// query) would still pass, because the stub answers whatever the test
// taught it.
//
// These tests do the opposite: the ONLY thing stubbed is Prisma itself.
// The real `loadPortfolio` / `loadInsights` run against the real
// `getPrimaryIntegrations` and `readSnapshots` implementations, and the
// fake Prisma is a *recording* fake — it answers the methods the loaders
// legitimately need from in-memory tables (with faithful `where` /
// `select` / `orderBy` / `skip` / `take` handling, so a loader that
// relies on an unselected field or an unfiltered row fails), records
// every call, and THROWS on any method it does not provide. Each test
// asserts the exact recorded call set, so a regression to per-website
// calls (or any new Prisma call) fails here instead of passing silently
// behind a barrel mock.
//
// Two mock registrations are needed for one fake, because the modules
// reach Prisma through two different specifiers (see
// db-snapshots-seed.test.ts): `@metricflock/db` (the loaders,
// `@metricflock/google/client`, `@metricflock/auth`) and the relative
// `./client` import inside `packages/db/src/snapshots.ts`. Both
// factories return the same fake object, so every call lands in one log.

type Row = Record<string, unknown>;
type CallRecord = { path: string; args: unknown[] };

const mocks = vi.hoisted(() => {
  const calls: CallRecord[] = [];
  const cacheRows: Array<{ cacheKey: string; payload: unknown; expiresAt: Date; createdAt: Date; updatedAt: Date }> =
    [];

  const websites: Row[] = [
    {
      id: "w1",
      name: "Site One",
      domain: "one.example",
      organizationId: "org1",
      teamId: "t1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: "w2",
      name: "Site Two",
      domain: "two.example",
      organizationId: "org1",
      teamId: "t1",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    },
    {
      id: "w3",
      name: "Site Three",
      domain: "three.example",
      organizationId: "org1",
      teamId: "t2",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    },
  ];
  const teamMembers: Row[] = [{ userId: "u2", teamId: "t1", isAdmin: true }];
  const websiteAssignments: Row[] = [];
  // w1 has TWO GA4 rows: the primary one must win over the older
  // non-primary one — the real getPrimaryIntegrations relies on the
  // (isPrimary desc, updatedAt desc) order, and the loader must build
  // its cache key from the primary row's externalId.
  const integrations: Row[] = [
    {
      websiteId: "w1",
      provider: "GA4",
      mappingStatus: "MAPPED",
      isPrimary: false,
      externalId: "properties/w1-old",
      updatedAt: new Date("2026-11-01T00:00:00Z"),
      googleConnectionId: "conn1",
    },
    {
      websiteId: "w1",
      provider: "GA4",
      mappingStatus: "MAPPED",
      isPrimary: true,
      externalId: "properties/w1",
      updatedAt: new Date("2026-11-10T00:00:00Z"),
      googleConnectionId: "conn1",
    },
    {
      websiteId: "w1",
      provider: "SEARCH_CONSOLE",
      mappingStatus: "MAPPED",
      isPrimary: true,
      externalId: "sc-domain:one.example",
      updatedAt: new Date("2026-11-10T00:00:00Z"),
      googleConnectionId: "conn1",
    },
    {
      websiteId: "w1",
      provider: "ADSENSE",
      mappingStatus: "MAPPED",
      isPrimary: true,
      externalId: "pub-123",
      updatedAt: new Date("2026-11-10T00:00:00Z"),
      googleConnectionId: "conn1",
    },
    {
      websiteId: "w2",
      provider: "GA4",
      mappingStatus: "MAPPED",
      isPrimary: true,
      externalId: "properties/w2",
      updatedAt: new Date("2026-11-10T00:00:00Z"),
      googleConnectionId: "conn1",
    },
    // w2 also has an AdSense mapping (but no GA4 snapshot): its AdSense
    // snapshot is what makes it a revenue-only insights entry. Without
    // this row the loader never asks for w2's AdSense key at all — a
    // snapshot without a mapping is invisible by design.
    {
      websiteId: "w2",
      provider: "ADSENSE",
      mappingStatus: "MAPPED",
      isPrimary: true,
      externalId: "pub-123",
      updatedAt: new Date("2026-11-10T00:00:00Z"),
      googleConnectionId: "conn1",
    },
  ];

  function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      const value = row[key];
      if (cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
        const c = cond as Row;
        if ("in" in c) {
          if (!Array.isArray(c.in) || !c.in.includes(value)) return false;
        } else if ("startsWith" in c) {
          if (typeof value !== "string" || !value.startsWith(c.startsWith as string)) return false;
        } else {
          // An operator the fake does not implement must fail loudly,
          // not silently mis-filter — otherwise a wrong `where` could
          // pass with the wrong rows.
          throw new Error(`recording fake: unsupported where operator in ${JSON.stringify(cond)}`);
        }
      } else if (value !== cond) {
        return false;
      }
    }
    return true;
  }

  function project(row: Row, select: Row | undefined): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [key, wanted] of Object.entries(select)) if (wanted) out[key] = row[key];
    return out;
  }

  // A namespace that throws on any method it does not provide, so a
  // loader calling a Prisma method the stub lacks fails loudly instead
  // of silently receiving `undefined`. Symbols pass through so
  // inspection utilities (pretty-format, etc.) do not trip the guard.
  // `allowUndefined` lists non-method properties a module reads at
  // import time without calling them: better-auth's prismaAdapter reads
  // `prisma._runtimeDataModel` while building the auth instance
  // (server.ts) — a plain-object mock returns `undefined` there, so
  // the fake does the same instead of throwing.
  function strict<T extends object>(model: string, methods: T, allowUndefined: string[] = []): T {
    return new Proxy(methods, {
      get(target, prop) {
        if (typeof prop === "symbol" || prop in target || allowUndefined.includes(prop as string)) {
          return (target as Record<string | symbol, unknown>)[prop];
        }
        throw new Error(
          `recording fake: prisma.${model}.${String(prop)} is not provided — a loader called a Prisma method the stub does not provide (A-COV-10)`,
        );
      },
    });
  }

  const prisma = strict(
    "prisma",
    {
      website: strict("website", {
        count: async (args: { where?: Row }) => {
          calls.push({ path: "website.count", args: [args] });
          return websites.filter((w) => matches(w, args?.where)).length;
        },
        findMany: async (args: { where?: Row; select?: Row; orderBy?: Row; skip?: number; take?: number }) => {
          calls.push({ path: "website.findMany", args: [args] });
          let rows = websites.filter((w) => matches(w, args?.where));
          rows = [...rows].sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
          if (args?.skip) rows = rows.slice(args.skip);
          if (args?.take !== undefined) rows = rows.slice(0, args.take);
          return rows.map((r) => project(r, args?.select));
        },
      }),
      websiteIntegration: strict("websiteIntegration", {
        findMany: async (args: { where?: Row; orderBy?: Row[] }) => {
          calls.push({ path: "websiteIntegration.findMany", args: [args] });
          const rows = integrations.filter((r) => matches(r, args?.where));
          rows.sort((a, b) => {
            if (Boolean(b.isPrimary) !== Boolean(a.isPrimary)) return Boolean(b.isPrimary) ? 1 : -1;
            return (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime();
          });
          return rows.map((r) => ({ ...r }));
        },
      }),
      analyticsCache: strict("analyticsCache", {
        findMany: async (args: { where?: Row; select?: Row }) => {
          calls.push({ path: "analyticsCache.findMany", args: [args] });
          return cacheRows
            .filter((r) => matches(r as unknown as Row, args?.where))
            .map((r) => project(r as unknown as Row, args?.select));
        },
      }),
      teamMember: strict("teamMember", {
        findMany: async (args: { where?: Row; select?: Row }) => {
          calls.push({ path: "teamMember.findMany", args: [args] });
          return teamMembers.filter((r) => matches(r, args?.where)).map((r) => project(r, args?.select));
        },
      }),
      websiteAssignment: strict("websiteAssignment", {
        findMany: async (args: { where?: Row; select?: Row }) => {
          calls.push({ path: "websiteAssignment.findMany", args: [args] });
          return websiteAssignments.filter((r) => matches(r, args?.where)).map((r) => project(r, args?.select));
        },
      }),
    },
    ["_runtimeDataModel"],
  );

  return { calls, cacheRows, prisma };
});

vi.mock("@metricflock/db", () => ({ prisma: mocks.prisma }));

const CLIENT_PATH = path.resolve(process.cwd(), "../../packages/db/src/client.ts");

let loadPortfolio: typeof import("@/lib/portfolio").loadPortfolio;
let loadInsights: typeof import("@/lib/insights").loadInsights;
let buildCacheKey: typeof import("@metricflock/shared").buildCacheKey;
let resolveRange: typeof import("@/lib/analytics-response").resolveRange;
let clampSearchConsoleRange: typeof import("@metricflock/google/search-console").clampSearchConsoleRange;
let getPrimaryIntegration: typeof import("@metricflock/google/client").getPrimaryIntegration;

const ADMIN = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN" };
const MEMBER = { id: "u2", organizationId: "org1", role: "TEAM_MEMBER" };
const FIXED_START = "2026-10-26";
const FIXED_END = "2026-11-22";
const FIXED_RANGE = `${FIXED_START}_${FIXED_END}`;

const ga4OverviewPayload = {
  summary: {
    sessions: 1000,
    engagedSessions: 500,
    keyEvents: 10,
    activeUsers: 800,
    newUsers: 100,
    screenPageViews: 2000,
    eventCount: 3000,
  },
};
const ga4TrafficPayload = { rows: [{ dimension0: "Organic Search", sessions: 100 }] };
const scPayload = {
  totals: { clicks: 10, impressions: 1000, avgCtr: 0.01, avgPosition: 7 },
  rows: [{ keys: ["2026-11-01", "best widgets", "/w"], clicks: 10, impressions: 1000, position: 7 }],
};
const adsensePayload = (earnings: string, pageViews: string) => ({
  totalsByMetric: { ESTIMATED_EARNINGS: earnings, PAGE_VIEWS: pageViews, IMPRESSIONS: pageViews, CLICKS: "0" },
  rows: [{ DATE: "2026-11-01", ESTIMATED_EARNINGS: Number(earnings) }],
});

function keyFor(websiteId: string, propertyId: string, source: string, report: string, range: string): string {
  return buildCacheKey({ organizationId: "org1", websiteId, propertyId, source, report, range });
}

function seedCache(cacheKey: string, payload: unknown, stale = false): void {
  mocks.cacheRows.push({
    cacheKey,
    payload,
    expiresAt: new Date(Date.now() + (stale ? -60_000 : 3_600_000)),
    createdAt: new Date("2026-11-22T00:00:00Z"),
    // A-API-14: the snapshot was rewritten after its first write, so the
    // last-write time is later than the first-write time.
    updatedAt: new Date("2026-11-22T12:00:00Z"),
  });
}

const SELECT_ALL = { cacheKey: true, payload: true, expiresAt: true, updatedAt: true };
const WEBSITE_SELECT = { id: true, name: true, domain: true };
const ORDER_BY = [{ isPrimary: "desc" }, { updatedAt: "desc" }];

beforeAll(async () => {
  // snapshots.ts imports Prisma through ./client, not the barrel — the
  // specifier mock above misses it (see db-snapshots-seed.test.ts), so
  // the same fake is registered by absolute path before the loaders
  // are imported dynamically.
  vi.doMock(CLIENT_PATH, () => ({ prisma: mocks.prisma }));
  vi.resetModules();
  ({ loadPortfolio } = await import("@/lib/portfolio"));
  ({ loadInsights } = await import("@/lib/insights"));
  ({ buildCacheKey } = await import("@metricflock/shared"));
  ({ resolveRange } = await import("@/lib/analytics-response"));
  ({ clampSearchConsoleRange } = await import("@metricflock/google/search-console"));
  ({ getPrimaryIntegration } = await import("@metricflock/google/client"));
});

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.cacheRows.length = 0;
  const range28 = resolveRange("28d");
  const key28 = `${range28.startDate}_${range28.endDate}`;
  const scRange = clampSearchConsoleRange(range28.startDate, range28.endDate);
  const scKey28 = `${scRange.startDate}_${scRange.endDate}`;
  // GA4 overview under both ranges the tests ask for (fixed range for
  // the portfolio test, 28d range for the insights/pair tests).
  seedCache(keyFor("w1", "properties/w1", "ga4", "overview", FIXED_RANGE), ga4OverviewPayload);
  seedCache(keyFor("w1", "properties/w1", "ga4", "overview", key28), ga4OverviewPayload);
  seedCache(keyFor("w1", "properties/w1", "ga4", "traffic", key28), ga4TrafficPayload);
  seedCache(keyFor("w1", "sc-domain:one.example", "search-console", "search-console", scKey28), scPayload);
  seedCache(keyFor("w1", "pub-123", "adsense", "adsense", key28), adsensePayload("50", "4000"));
  // w2 has an AdSense snapshot only (stale) — a revenue-only insights
  // entry. It has a GA4 mapping but no GA4 snapshot, so the portfolio
  // loader must report it "no_snapshot_yet".
  seedCache(keyFor("w2", "pub-123", "adsense", "adsense", key28), adsensePayload("25", "2000"), true);
});

describe("loaders wiring (A-COV-10) — real loaders + real batch helpers, stubbed Prisma only", () => {
  it("loadPortfolio (GA4) runs the real getPrimaryIntegrations + readSnapshots against the fake", async () => {
    const result = await loadPortfolio(ADMIN, {
      provider: "GA4",
      source: "ga4",
      report: "overview",
      startDate: FIXED_START,
      endDate: FIXED_END,
    });
    expect(result.websites).toHaveLength(1);
    expect(result.websites[0]).toMatchObject({ websiteId: "w1", name: "Site One", stale: false });
    expect(result.totals?.sessions).toBe(1000);
    expect(result.unavailableWebsites).toEqual(
      expect.arrayContaining([
        { websiteId: "w2", reason: "no_snapshot_yet" },
        { websiteId: "w3", reason: "no_property_mapped" },
      ]),
    );
    expect(result.websiteCount).toBe(3);
    expect(result.truncated).toBe(false);
    // The primary GA4 row wins: the snapshot was found, so the loader
    // built its key from "properties/w1", not the older "properties/w1-old".
    expect(mocks.calls).toEqual([
      { path: "website.count", args: [{ where: { organizationId: "org1" } }] },
      {
        path: "website.findMany",
        args: [
          {
            where: { organizationId: "org1" },
            select: WEBSITE_SELECT,
            orderBy: { createdAt: "asc" },
            skip: 0,
            take: 200,
          },
        ],
      },
      {
        path: "websiteIntegration.findMany",
        args: [
          {
            where: { websiteId: { in: ["w1", "w2", "w3"] }, provider: { in: ["GA4"] }, mappingStatus: "MAPPED" },
            orderBy: ORDER_BY,
          },
        ],
      },
      {
        path: "analyticsCache.findMany",
        args: [
          {
            where: {
              cacheKey: {
                in: [
                  keyFor("w1", "properties/w1", "ga4", "overview", FIXED_RANGE),
                  keyFor("w2", "properties/w2", "ga4", "overview", FIXED_RANGE),
                ],
              },
            },
            select: SELECT_ALL,
          },
        ],
      },
    ]);
  });

  it("loadPortfolio (SEARCH_CONSOLE) asks for the clamped range key (A-GGL-07 wiring)", async () => {
    const range = resolveRange("28d");
    const scRange = clampSearchConsoleRange(range.startDate, range.endDate);
    const result = await loadPortfolio(ADMIN, {
      provider: "SEARCH_CONSOLE",
      source: "search-console",
      report: "search-console",
      startDate: range.startDate,
      endDate: range.endDate,
    });
    expect(result.websites).toHaveLength(1);
    expect(result.websites[0]).toMatchObject({ websiteId: "w1" });
    expect(result.totals?.clicks).toBe(10);
    expect(result.unavailableWebsites).toEqual(
      expect.arrayContaining([
        { websiteId: "w2", reason: "no_property_mapped" },
        { websiteId: "w3", reason: "no_property_mapped" },
      ]),
    );
    const cacheCall = mocks.calls.find((c) => c.path === "analyticsCache.findMany");
    expect(cacheCall).toBeDefined();
    const keys = (cacheCall!.args[0] as { where: { cacheKey: { in: string[] } } }).where.cacheKey.in;
    expect(keys).toEqual([
      keyFor(
        "w1",
        "sc-domain:one.example",
        "search-console",
        "search-console",
        `${scRange.startDate}_${scRange.endDate}`,
      ),
    ]);
    // The unclamped end date must not appear in any requested key.
    expect(keys.every((k) => !k.includes(`_${range.endDate}:`))).toBe(true);
  });

  it("loadInsights runs the real loaders end-to-end with one batched call per Prisma method", async () => {
    const range = resolveRange("28d");
    const key28 = `${range.startDate}_${range.endDate}`;
    const scRange = clampSearchConsoleRange(range.startDate, range.endDate);
    const scKey28 = `${scRange.startDate}_${scRange.endDate}`;
    const result = await loadInsights(ADMIN);
    expect(result.range).toEqual(range);
    expect(result.websites).toHaveLength(2);
    const w1 = result.websites.find((w) => w.websiteId === "w1");
    const w2 = result.websites.find((w) => w.websiteId === "w2");
    expect(w1?.seo).not.toBeNull();
    expect(w1?.revenue).not.toBeNull();
    expect(w1?.channels).toHaveLength(1);
    expect(w2?.seo).toBeNull();
    expect(w2?.revenue).not.toBeNull();
    expect(w2?.channels).toEqual([]);
    expect(result.unavailableCount).toBe(1); // w3, no mapping at all
    expect(result.summary.totalEarnings).toBe(75);
    expect(result.summary.earningsPerThousandSessions).toBe(75);
    expect(result.summary.blendedPageRpm).toBeCloseTo(12.5);
    // Exactly three Prisma calls, in loader order — no count, no
    // per-website calls, no stubbed sibling loader.
    expect(mocks.calls).toEqual([
      {
        path: "website.findMany",
        args: [
          {
            where: { organizationId: "org1" },
            select: WEBSITE_SELECT,
            orderBy: { createdAt: "asc" },
            take: 200,
          },
        ],
      },
      {
        path: "websiteIntegration.findMany",
        args: [
          {
            where: {
              websiteId: { in: ["w1", "w2", "w3"] },
              provider: { in: ["GA4", "SEARCH_CONSOLE", "ADSENSE"] },
              mappingStatus: "MAPPED",
            },
            orderBy: ORDER_BY,
          },
        ],
      },
      {
        path: "analyticsCache.findMany",
        args: [
          {
            where: {
              cacheKey: {
                in: [
                  keyFor("w1", "sc-domain:one.example", "search-console", "search-console", scKey28),
                  keyFor("w1", "pub-123", "adsense", "adsense", key28),
                  keyFor("w1", "properties/w1", "ga4", "traffic", key28),
                  keyFor("w2", "pub-123", "adsense", "adsense", key28),
                  keyFor("w2", "properties/w2", "ga4", "traffic", key28),
                  keyFor("w1", "properties/w1", "ga4", "overview", key28),
                  keyFor("w2", "properties/w2", "ga4", "overview", key28),
                ],
              },
            },
            select: SELECT_ALL,
          },
        ],
      },
    ]);
  });

  it("loadPortfolio + loadInsights agree on summary totals for the same fixture (pair consistency)", async () => {
    const range = resolveRange("28d");
    const ga4 = await loadPortfolio(ADMIN, {
      provider: "GA4",
      source: "ga4",
      report: "overview",
      startDate: range.startDate,
      endDate: range.endDate,
    });
    const adsense = await loadPortfolio(ADMIN, {
      provider: "ADSENSE",
      source: "adsense",
      report: "adsense",
      startDate: range.startDate,
      endDate: range.endDate,
    });
    const insights = await loadInsights(ADMIN);
    expect(ga4.totals?.sessions).toBe(1000);
    expect(adsense.totals?.ESTIMATED_EARNINGS).toBe(75);
    expect(insights.summary.earningsPerThousandSessions).toBe(75);
    expect(insights.summary.totalEarnings).toBe(adsense.totals?.ESTIMATED_EARNINGS);
    // No per-website or single-row Prisma call anywhere in the pair:
    // the loaders only ever issue the batched methods.
    expect(mocks.calls.every((c) => !c.path.includes("findFirst") && !c.path.includes("findUnique"))).toBe(true);
  });

  it("restricted user: the real listAccessibleWebsiteIds scopes every query (team t1 only)", async () => {
    const result = await loadPortfolio(MEMBER, {
      provider: "GA4",
      source: "ga4",
      report: "overview",
      startDate: FIXED_START,
      endDate: FIXED_END,
    });
    expect(result.websiteCount).toBe(2);
    expect(result.websites).toHaveLength(1);
    expect(result.websites[0]).toMatchObject({ websiteId: "w1" });
    expect(result.unavailableWebsites).toEqual([{ websiteId: "w2", reason: "no_snapshot_yet" }]);
    expect(mocks.calls).toEqual([
      { path: "teamMember.findMany", args: [{ where: { userId: "u2", isAdmin: true }, select: { teamId: true } }] },
      {
        path: "website.findMany",
        args: [{ where: { organizationId: "org1", teamId: { in: ["t1"] } }, select: { id: true } }],
      },
      { path: "websiteAssignment.findMany", args: [{ where: { userId: "u2" }, select: { websiteId: true } }] },
      { path: "website.count", args: [{ where: { organizationId: "org1", id: { in: ["w1", "w2"] } } }] },
      {
        path: "website.findMany",
        args: [
          {
            where: { organizationId: "org1", id: { in: ["w1", "w2"] } },
            select: WEBSITE_SELECT,
            orderBy: { createdAt: "asc" },
            skip: 0,
            take: 200,
          },
        ],
      },
      {
        path: "websiteIntegration.findMany",
        args: [
          {
            where: { websiteId: { in: ["w1", "w2"] }, provider: { in: ["GA4"] }, mappingStatus: "MAPPED" },
            orderBy: ORDER_BY,
          },
        ],
      },
      {
        path: "analyticsCache.findMany",
        args: [
          {
            where: {
              cacheKey: {
                in: [
                  keyFor("w1", "properties/w1", "ga4", "overview", FIXED_RANGE),
                  keyFor("w2", "properties/w2", "ga4", "overview", FIXED_RANGE),
                ],
              },
            },
            select: SELECT_ALL,
          },
        ],
      },
    ]);
  });

  it("the recording fake fails loudly on any Prisma method it does not provide", async () => {
    const integration = mocks.prisma.websiteIntegration as unknown as Record<string, unknown>;
    expect(() => integration["findFirst"]).toThrow(/not provided/);
    const cache = mocks.prisma.analyticsCache as unknown as Record<string, unknown>;
    expect(() => cache["upsert"]).toThrow(/not provided/);
    const top = mocks.prisma as unknown as Record<string, unknown>;
    expect(() => top["user"]).toThrow(/not provided/);
    // The old per-website path cannot silently pass in this harness:
    // the real getPrimaryIntegration calls websiteIntegration.findFirst,
    // which this fake does not provide — so a loader that regressed to
    // it would fail here instead of passing behind a barrel mock.
    await expect(getPrimaryIntegration("w1", "GA4")).rejects.toThrow(/not provided/);
  });
});
