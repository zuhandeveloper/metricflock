import { describe, it, expect, vi } from "vitest";
import { discoverConnectionProperties, type SyncDeps } from "@metricflock/google/sync";

// A-GGL-13: per-provider isolation, honest counts, and stale pruning in the
// worker's discoverConnectionProperties. The Prisma double below is a real
// in-memory store (not bare vi.fn stubs) so pruning can be asserted
// end-to-end: discover, remove a property at the stub, re-discover, and
// check the row is gone.
const moduleMocks = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  setCredentials: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({ prisma: { website: { findUnique: vi.fn() } } }));
vi.mock("@metricflock/db/health", () => ({ recordHealth: vi.fn() }));
vi.mock("@metricflock/db/snapshots", () => ({ writeSnapshot: vi.fn() }));
vi.mock("@metricflock/google/tokens", () => ({
  getValidAccessToken: moduleMocks.getValidAccessToken,
}));
vi.mock("@metricflock/google/oauth", () => ({
  getOAuthClient: () => ({ setCredentials: moduleMocks.setCredentials }),
}));

type TableKey = "googleProperty" | "searchConsoleProperty" | "adSenseAccount" | "adManagerNetwork";
const KEY_FIELD: Record<TableKey, string> = {
  googleProperty: "propertyId",
  searchConsoleProperty: "siteUrl",
  adSenseAccount: "accountId",
  adManagerNetwork: "networkCode",
};
type Row = Record<string, string | null>;

function makeStore() {
  const rows: Record<TableKey, Row[]> = {
    googleProperty: [],
    searchConsoleProperty: [],
    adSenseAccount: [],
    adManagerNetwork: [],
  };
  const integrations: Row[] = [];
  const failKeys = new Set<string>();
  let seq = 0;

  function tableFake(table: TableKey) {
    const keyField = KEY_FIELD[table];
    return {
      upsert: vi.fn(async ({ update, create }: { update: Row; create: Row }) => {
        if (failKeys.has(String(create[keyField]))) throw new Error(`upsert failed for ${create[keyField]}`);
        const existing = rows[table].find(
          (r) => r.connectionId === create.connectionId && r[keyField] === create[keyField],
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { id: `${table}-${++seq}`, ...create };
        rows[table].push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { connectionId: string } }) =>
        rows[table].filter((r) => r.connectionId === where.connectionId),
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        const before = rows[table].length;
        rows[table] = rows[table].filter((r) => !ids.has(r.id as string));
        return { count: before - rows[table].length };
      }),
    };
  }

  const prisma = {
    googleProperty: tableFake("googleProperty"),
    searchConsoleProperty: tableFake("searchConsoleProperty"),
    adSenseAccount: tableFake("adSenseAccount"),
    adManagerNetwork: tableFake("adManagerNetwork"),
    websiteIntegration: {
      findMany: vi.fn(async ({ where }: { where: Record<string, { in: string[] }> }) => {
        const [fk, cond] = Object.entries(where)[0];
        const ids = new Set(cond.in);
        return integrations.filter((r) => r[fk] != null && ids.has(r[fk] as string));
      }),
    },
  };
  return { rows, integrations, failKeys, prisma };
}

function makeDeps() {
  const store = makeStore();
  const discovery = {
    listGa4Properties: vi.fn(
      async (): Promise<{
        items: { propertyId: string; displayName?: string; accountId?: string }[];
        truncated: boolean;
        errors: string[];
      }> => ({ items: [], truncated: false, errors: [] }),
    ),
    listSearchConsoleSites: vi.fn(
      async (): Promise<{ items: { siteUrl: string; permissionLevel?: string }[]; truncated: boolean }> => ({
        items: [],
        truncated: false,
      }),
    ),
    listAdSenseAccounts: vi.fn(
      async (): Promise<{ items: { accountId: string; displayName?: string }[]; truncated: boolean }> => ({
        items: [],
        truncated: false,
      }),
    ),
  };
  const adManager = {
    runAdManagerReport: vi.fn(async () => ({})),
    adManagerEnabled: vi.fn(() => false),
    listAdManagerNetworks: vi.fn(async () => [] as { networkCode: string; displayName?: string }[]),
  };
  const deps = {
    getConnectionAuth: vi.fn(async () => ({})),
    discovery,
    adManager,
    prisma: store.prisma,
  } as unknown as SyncDeps;
  return { deps, store, discovery, adManager };
}

describe("discoverConnectionProperties — per-provider isolation (A-GGL-13)", () => {
  it("GA4 listing throws: SC/AdSense counts still returned and stored", async () => {
    const { deps, store, discovery } = makeDeps();
    discovery.listGa4Properties.mockRejectedValueOnce(
      new Error("Analytics Admin API has not been used in project 123 before"),
    );
    discovery.listSearchConsoleSites.mockResolvedValueOnce({
      items: [{ siteUrl: "https://example.com/" }],
      truncated: false,
    });
    discovery.listAdSenseAccounts.mockResolvedValueOnce({
      items: [{ accountId: "pub-1" }],
      truncated: false,
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.ga4).toBe(0);
    expect(counts.searchConsole).toBe(1);
    expect(counts.adsense).toBe(1);
    expect(counts.errors?.ga4).toMatch(/Analytics Admin API/);
    expect(counts.errors?.searchConsole).toBeUndefined();
    expect(store.rows.searchConsoleProperty).toHaveLength(1);
    expect(store.rows.adSenseAccount).toHaveLength(1);
  });

  it("Ad Manager listing throws: the other providers still run", async () => {
    const { deps, store, discovery, adManager } = makeDeps();
    adManager.adManagerEnabled.mockReturnValue(true);
    adManager.listAdManagerNetworks.mockRejectedValueOnce(new Error("Ad Manager API disabled"));
    discovery.listGa4Properties.mockResolvedValueOnce({
      items: [{ propertyId: "p1" }],
      truncated: false,
      errors: [],
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.ga4).toBe(1);
    expect(counts.adManager).toBe(0);
    expect(counts.errors?.adManager).toMatch(/Ad Manager API disabled/);
    expect(store.rows.googleProperty).toHaveLength(1);
  });

  it("counts only successful upserts", async () => {
    const { deps, store, discovery } = makeDeps();
    store.failKeys.add("p2");
    discovery.listGa4Properties.mockResolvedValueOnce({
      items: [{ propertyId: "p1" }, { propertyId: "p2" }, { propertyId: "p3" }],
      truncated: false,
      errors: [],
    });
    discovery.listSearchConsoleSites.mockResolvedValueOnce({
      items: [{ siteUrl: "https://example.com/" }],
      truncated: false,
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.ga4).toBe(2);
    expect(counts.searchConsole).toBe(1);
    expect(counts.errors?.ga4).toMatch(/upsert failed for p2/);
    expect(store.rows.googleProperty.map((r) => r.propertyId).sort()).toEqual(["p1", "p3"]);
  });

  it("clean run returns exactly the four counts (no errors/pruned keys)", async () => {
    const { deps, discovery } = makeDeps();
    discovery.listGa4Properties.mockResolvedValueOnce({
      items: [{ propertyId: "p1" }],
      truncated: false,
      errors: [],
    });
    discovery.listSearchConsoleSites.mockResolvedValueOnce({
      items: [{ siteUrl: "https://example.com/" }],
      truncated: false,
    });
    discovery.listAdSenseAccounts.mockResolvedValueOnce({
      items: [{ accountId: "pub-1" }],
      truncated: false,
    });
    await expect(discoverConnectionProperties("conn-1", deps)).resolves.toEqual({
      ga4: 1,
      searchConsole: 1,
      adsense: 1,
      adManager: 0,
    });
  });
});

describe("discoverConnectionProperties — stale pruning (A-GGL-13)", () => {
  it("re-discover after removing a property at the stub prunes the stale row", async () => {
    const { deps, store, discovery } = makeDeps();
    discovery.listGa4Properties.mockResolvedValue({
      items: [{ propertyId: "p1" }, { propertyId: "p2" }],
      truncated: false,
      errors: [],
    });
    await discoverConnectionProperties("conn-1", deps);
    expect(store.rows.googleProperty).toHaveLength(2);

    discovery.listGa4Properties.mockResolvedValue({
      items: [{ propertyId: "p1" }],
      truncated: false,
      errors: [],
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.ga4).toBe(1);
    expect(counts.pruned?.ga4).toBe(1);
    expect(store.rows.googleProperty.map((r) => r.propertyId)).toEqual(["p1"]);
  });

  it("prunes stale rows for every provider, not just GA4", async () => {
    const { deps, store, discovery, adManager } = makeDeps();
    adManager.adManagerEnabled.mockReturnValue(true);
    adManager.listAdManagerNetworks.mockResolvedValue([{ networkCode: "n1" }, { networkCode: "n2" }]);
    discovery.listSearchConsoleSites.mockResolvedValue({
      items: [{ siteUrl: "https://a.example/" }, { siteUrl: "https://b.example/" }],
      truncated: false,
    });
    discovery.listAdSenseAccounts.mockResolvedValue({
      items: [{ accountId: "pub-1" }, { accountId: "pub-2" }],
      truncated: false,
    });
    await discoverConnectionProperties("conn-1", deps);
    expect(store.rows.searchConsoleProperty).toHaveLength(2);
    expect(store.rows.adSenseAccount).toHaveLength(2);
    expect(store.rows.adManagerNetwork).toHaveLength(2);

    discovery.listSearchConsoleSites.mockResolvedValue({
      items: [{ siteUrl: "https://a.example/" }],
      truncated: false,
    });
    discovery.listAdSenseAccounts.mockResolvedValue({
      items: [{ accountId: "pub-1" }],
      truncated: false,
    });
    adManager.listAdManagerNetworks.mockResolvedValue([{ networkCode: "n1" }]);
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.pruned).toEqual({ searchConsole: 1, adsense: 1, adManager: 1 });
    expect(store.rows.searchConsoleProperty.map((r) => r.siteUrl)).toEqual(["https://a.example/"]);
    expect(store.rows.adSenseAccount.map((r) => r.accountId)).toEqual(["pub-1"]);
    expect(store.rows.adManagerNetwork.map((r) => r.networkCode)).toEqual(["n1"]);
  });

  it("a stale row still referenced by an integration is kept, never deleted", async () => {
    const { deps, store, discovery } = makeDeps();
    discovery.listGa4Properties.mockResolvedValue({
      items: [{ propertyId: "p1" }, { propertyId: "p2" }],
      truncated: false,
      errors: [],
    });
    await discoverConnectionProperties("conn-1", deps);
    const p2 = store.rows.googleProperty.find((r) => r.propertyId === "p2")!;
    store.integrations.push({ googlePropertyId: p2.id });

    discovery.listGa4Properties.mockResolvedValue({
      items: [{ propertyId: "p1" }],
      truncated: false,
      errors: [],
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.pruned).toBeUndefined();
    expect(store.rows.googleProperty.map((r) => r.propertyId).sort()).toEqual(["p1", "p2"]);
  });

  it("prune is skipped on a truncated listing", async () => {
    const { deps, store, discovery } = makeDeps();
    discovery.listGa4Properties.mockResolvedValue({
      items: [{ propertyId: "p1" }, { propertyId: "p2" }],
      truncated: false,
      errors: [],
    });
    await discoverConnectionProperties("conn-1", deps);

    discovery.listGa4Properties.mockResolvedValue({
      items: [{ propertyId: "p1" }],
      truncated: true,
      errors: [],
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.pruned).toBeUndefined();
    expect(store.rows.googleProperty).toHaveLength(2);
  });

  it("prune is skipped when the GA4 listing has partial account errors", async () => {
    const { deps, store, discovery } = makeDeps();
    discovery.listGa4Properties.mockResolvedValue({
      items: [{ propertyId: "p1" }, { propertyId: "p2" }],
      truncated: false,
      errors: [],
    });
    await discoverConnectionProperties("conn-1", deps);

    discovery.listGa4Properties.mockResolvedValue({
      items: [{ propertyId: "p1" }],
      truncated: false,
      errors: ["accounts/123"],
    });
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.pruned).toBeUndefined();
    expect(store.rows.googleProperty).toHaveLength(2);
  });

  it("prune is skipped for a provider whose listing failed", async () => {
    const { deps, store, discovery } = makeDeps();
    discovery.listSearchConsoleSites.mockResolvedValue({
      items: [{ siteUrl: "https://example.com/" }],
      truncated: false,
    });
    await discoverConnectionProperties("conn-1", deps);
    expect(store.rows.searchConsoleProperty).toHaveLength(1);

    discovery.listSearchConsoleSites.mockRejectedValueOnce(new Error("Search Console API disabled"));
    const counts = await discoverConnectionProperties("conn-1", deps);
    expect(counts.errors?.searchConsole).toMatch(/Search Console API disabled/);
    expect(counts.pruned).toBeUndefined();
    expect(store.rows.searchConsoleProperty).toHaveLength(1);
  });
});
