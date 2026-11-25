import path from "node:path";
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";

// A-DB-12 backfill: `packages/db/scripts/backfill-legacy-connections.ts`.
// The script imports the Prisma client through ../src/client, so it is
// mocked by computed absolute path (the db-snapshots-seed.test.ts
// pattern) and imported dynamically after the mock is registered; the
// exported function takes the client as an argument, so the tests pass
// the mock explicitly. Importing the module must not run the CLI main
// (guarded by the import.meta.url check in the script).
const mocks = vi.hoisted(() => ({
  integrationFindMany: vi.fn(),
  integrationUpdate: vi.fn(),
  integrationCount: vi.fn(),
  websiteFindUnique: vi.fn(),
  ga4FindMany: vi.fn(),
  scFindMany: vi.fn(),
  adsenseFindMany: vi.fn(),
  admanFindMany: vi.fn(),
  disconnect: vi.fn(),
}));

const CLIENT_PATH = path.resolve(process.cwd(), "../../packages/db/src/client.ts");
const SCRIPT_PATH = path.resolve(process.cwd(), "../../packages/db/scripts/backfill-legacy-connections.ts");

function registerClientMock() {
  vi.doMock(CLIENT_PATH, () => ({
    prisma: {
      websiteIntegration: {
        findMany: mocks.integrationFindMany,
        update: mocks.integrationUpdate,
        count: mocks.integrationCount,
      },
      website: { findUnique: mocks.websiteFindUnique },
      googleProperty: { findMany: mocks.ga4FindMany },
      searchConsoleProperty: { findMany: mocks.scFindMany },
      adSenseAccount: { findMany: mocks.adsenseFindMany },
      adManagerNetwork: { findMany: mocks.admanFindMany },
      $disconnect: mocks.disconnect,
    },
  }));
}

type BackfillModule = typeof import("../../../../packages/db/scripts/backfill-legacy-connections");
let backfill: BackfillModule;

async function loadBackfill(): Promise<BackfillModule> {
  registerClientMock();
  vi.resetModules();
  backfill = await import(SCRIPT_PATH);
  return backfill;
}

const legacyRow = (overrides: Record<string, unknown> = {}) => ({
  id: "int-1",
  websiteId: "site-1",
  provider: "GA4",
  externalId: "properties/123",
  googleConnectionId: null,
  mappingStatus: "MAPPED",
  isPrimary: true,
  ...overrides,
});

const discovered = (overrides: Record<string, unknown> = {}) => ({
  id: "gp-1",
  connection: { id: "conn-a", status: "ACTIVE", updatedAt: new Date("2026-11-20T00:00:00Z") },
  ...overrides,
});

describe("backfillLegacyConnections (A-DB-12)", () => {
  beforeAll(async () => {
    await loadBackfill();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.integrationFindMany.mockResolvedValue([]);
    mocks.integrationUpdate.mockResolvedValue({});
    mocks.integrationCount.mockResolvedValue(0);
    mocks.websiteFindUnique.mockResolvedValue({ organizationId: "org-1" });
    mocks.ga4FindMany.mockResolvedValue([]);
    mocks.scFindMany.mockResolvedValue([]);
    mocks.adsenseFindMany.mockResolvedValue([]);
    mocks.admanFindMany.mockResolvedValue([]);
  });

  const run = (opts: { limit?: number } = {}) =>
    backfill.backfillLegacyConnections(
      (mocks as unknown as Record<string, unknown>).prisma as unknown as Parameters<
        BackfillModule["backfillLegacyConnections"]
      >[0],
      opts,
    );

  // The mock above is the module-level prisma mock; the function takes
  // its client as an argument, so the tests pass the same mock object.
  beforeEach(() => {
    (mocks as unknown as Record<string, unknown>).prisma = {
      websiteIntegration: {
        findMany: mocks.integrationFindMany,
        update: mocks.integrationUpdate,
        count: mocks.integrationCount,
      },
      website: { findUnique: mocks.websiteFindUnique },
      googleProperty: { findMany: mocks.ga4FindMany },
      searchConsoleProperty: { findMany: mocks.scFindMany },
      adSenseAccount: { findMany: mocks.adsenseFindMany },
      adManagerNetwork: { findMany: mocks.admanFindMany },
    };
  });

  it("resolves a GA4 row when exactly one connection discovered the property", async () => {
    mocks.integrationFindMany.mockResolvedValue([legacyRow()]);
    mocks.ga4FindMany.mockResolvedValue([discovered()]);
    const result = await run();
    expect(mocks.ga4FindMany).toHaveBeenCalledWith({
      where: { propertyId: "properties/123", connection: { organizationId: "org-1" } },
      include: { connection: { select: { id: true, status: true, updatedAt: true } } },
    });
    expect(mocks.integrationUpdate).toHaveBeenCalledWith({
      where: { id: "int-1" },
      data: {
        googleConnectionId: "conn-a",
        googlePropertyId: "gp-1",
        searchConsolePropertyId: null,
        adsenseAccountId: null,
        adManagerNetworkId: null,
      },
    });
    expect(result).toEqual({ examined: 1, resolved: 1, demoted: 0, skipped: 0, remaining: 0, demotedIds: [] });
  });

  it("resolves to the most recently updated ACTIVE connection when several discovered the property", async () => {
    mocks.integrationFindMany.mockResolvedValue([legacyRow()]);
    mocks.ga4FindMany.mockResolvedValue([
      discovered({
        id: "gp-old",
        connection: { id: "conn-old", status: "ACTIVE", updatedAt: new Date("2026-11-01T00:00:00Z") },
      }),
      discovered({
        id: "gp-exp",
        connection: { id: "conn-exp", status: "EXPIRED", updatedAt: new Date("2026-11-22T00:00:00Z") },
      }),
      discovered({
        id: "gp-new",
        connection: { id: "conn-new", status: "ACTIVE", updatedAt: new Date("2026-11-21T00:00:00Z") },
      }),
    ]);
    await run();
    expect(mocks.integrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ googleConnectionId: "conn-new", googlePropertyId: "gp-new" }),
      }),
    );
  });

  it("demotes (never deletes) a row no connection discovered, preserving externalId", async () => {
    mocks.integrationFindMany.mockResolvedValue([legacyRow()]);
    const result = await run();
    expect(mocks.integrationUpdate).toHaveBeenCalledWith({
      where: { id: "int-1" },
      data: {
        mappingStatus: "UNMAPPED",
        isPrimary: false,
        googlePropertyId: null,
        searchConsolePropertyId: null,
        adsenseAccountId: null,
        adManagerNetworkId: null,
      },
    });
    // No delete path exists in the module: the mock client defines no
    // delete/deleteMany at all, so any delete would throw — the update
    // above is the only write.
    expect(result).toEqual({ examined: 1, resolved: 0, demoted: 1, skipped: 0, remaining: 0, demotedIds: ["int-1"] });
  });

  it("resolves a Search Console row by siteUrl", async () => {
    mocks.integrationFindMany.mockResolvedValue([
      legacyRow({ provider: "SEARCH_CONSOLE", externalId: "sc-domain:example.com" }),
    ]);
    mocks.scFindMany.mockResolvedValue([discovered({ id: "sc-1" })]);
    await run();
    expect(mocks.scFindMany).toHaveBeenCalledWith({
      where: { siteUrl: "sc-domain:example.com", connection: { organizationId: "org-1" } },
      include: { connection: { select: { id: true, status: true, updatedAt: true } } },
    });
    expect(mocks.integrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ googleConnectionId: "conn-a", searchConsolePropertyId: "sc-1" }),
      }),
    );
    expect(mocks.ga4FindMany).not.toHaveBeenCalled();
  });

  it("skips a row whose website no longer exists without touching it", async () => {
    mocks.integrationFindMany.mockResolvedValue([legacyRow()]);
    mocks.websiteFindUnique.mockResolvedValue(null);
    const result = await run();
    expect(mocks.integrationUpdate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ examined: 1, resolved: 0, demoted: 0, skipped: 1 });
  });

  it("processes at most limit rows per run and reports what remains", async () => {
    mocks.integrationFindMany.mockResolvedValue([legacyRow(), legacyRow({ id: "int-2" })]);
    mocks.integrationCount.mockResolvedValue(5);
    const result = await run({ limit: 2 });
    expect(mocks.integrationFindMany).toHaveBeenCalledWith({
      where: { mappingStatus: "MAPPED", googleConnectionId: null },
      orderBy: { id: "asc" },
      take: 2,
    });
    expect(result).toMatchObject({ examined: 2, remaining: 5 });
  });

  it("does nothing when there are no legacy rows", async () => {
    const result = await run();
    expect(mocks.integrationUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ examined: 0, resolved: 0, demoted: 0, skipped: 0, remaining: 0, demotedIds: [] });
  });
});
