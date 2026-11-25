import { describe, it, expect, vi } from "vitest";

// Phase 3 (F-3.3): discovery pagination. googleapis is mocked so the
// paginate loop, page cap, token-loop guard and per-account isolation
// are exercised without any network.
const { accountsList, propertiesList, sitesList, adsenseList } = vi.hoisted(() => ({
  accountsList: vi.fn(),
  propertiesList: vi.fn(),
  sitesList: vi.fn(),
  adsenseList: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    analyticsadmin: () => ({ accounts: { list: accountsList }, properties: { list: propertiesList } }),
    searchconsole: () => ({ sites: { list: sitesList } }),
    adsense: () => ({ accounts: { list: adsenseList } }),
  },
}));

import { listGa4Properties, listAdSenseAccounts, listSearchConsoleSites } from "@metricflock/google/discovery";

const auth = {} as never;

function accountPage(names: string[], nextPageToken?: string) {
  return { data: { accounts: names.map((n) => ({ name: `accounts/${n}` })), nextPageToken } };
}
function propertyPage(ids: string[], nextPageToken?: string) {
  return {
    data: { properties: ids.map((id) => ({ name: `properties/${id}`, displayName: `P${id}` })), nextPageToken },
  };
}

describe("listGa4Properties pagination", () => {
  it("follows nextPageToken for accounts and properties", async () => {
    accountsList.mockResolvedValueOnce(accountPage(["1"], "a2")).mockResolvedValueOnce(accountPage(["2"]));
    propertiesList
      .mockResolvedValueOnce(propertyPage(["10"], "p2"))
      .mockResolvedValueOnce(propertyPage(["11"]))
      .mockResolvedValueOnce(propertyPage(["20"]));
    const out = await listGa4Properties(auth);
    expect(out.items.map((p) => p.propertyId)).toEqual(["10", "11", "20"]);
    expect(out.truncated).toBe(false);
    expect(out.errors).toEqual([]);
    expect(accountsList).toHaveBeenCalledTimes(2);
    expect(propertiesList).toHaveBeenCalledTimes(3);
  });

  it("isolates a failing account and reports it", async () => {
    accountsList.mockResolvedValueOnce(accountPage(["1", "2"]));
    propertiesList.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(propertyPage(["20"]));
    const out = await listGa4Properties(auth);
    expect(out.items.map((p) => p.propertyId)).toEqual(["20"]);
    expect(out.errors).toEqual(["accounts/1"]);
  });

  it("stops at the page cap and flags truncated", async () => {
    accountsList.mockResolvedValueOnce(accountPage(["1"]));
    // distinct token each page so the loop guard does not fire first
    let n = 0;
    propertiesList.mockImplementation(async () => propertyPage([`x${n}`], `tok-${n++}`));
    const out = await listGa4Properties(auth);
    expect(out.truncated).toBe(true);
    expect(propertiesList).toHaveBeenCalledTimes(10);
  });

  it("loop guard stops a repeating nextPageToken", async () => {
    accountsList.mockResolvedValueOnce(accountPage(["1"]));
    propertiesList.mockResolvedValue(propertyPage(["10"], "same-token"));
    const out = await listGa4Properties(auth);
    expect(out.truncated).toBe(true);
    expect(propertiesList).toHaveBeenCalledTimes(2);
  });

  // A-API-13: volume bounds. Before the fix the only bound was the
  // 10-page cap: up to 10 pages x 200 accounts, each with up to 10
  // pages x 200 properties, all listed sequentially with no overall
  // timeout. These tests fail against the unbounded code.
  it("caps total GA4 properties at 1000 and flags truncated (A-API-13)", async () => {
    accountsList.mockResolvedValueOnce(accountPage(["1"]));
    let n = 0;
    propertiesList.mockImplementation(async () =>
      propertyPage(
        Array.from({ length: 200 }, (_, i) => `p${n * 200 + i}`),
        `tok-${n++}`,
      ),
    );
    const out = await listGa4Properties(auth);
    expect(out.items).toHaveLength(1000);
    expect(out.truncated).toBe(true);
    // 5 pages x 200 = 1000 — the 6th page (1200 total) is never fetched.
    expect(propertiesList).toHaveBeenCalledTimes(5);
  });

  it("caps enumerated GA4 accounts at 200 and flags truncated (A-API-13)", async () => {
    let page = 0;
    accountsList.mockImplementation(async () => {
      const names = Array.from({ length: 150 }, (_, i) => `a${page * 150 + i}`);
      return accountPage(names, `acct-tok-${page++}`);
    });
    propertiesList.mockResolvedValue(propertyPage(["only"]));
    const out = await listGa4Properties(auth);
    expect(out.items).toHaveLength(200);
    expect(out.truncated).toBe(true);
    // 2 account pages (150 + 150, sliced to 200) — the 3rd is never fetched.
    expect(accountsList).toHaveBeenCalledTimes(2);
    expect(propertiesList).toHaveBeenCalledTimes(200);
  });

  it("stops listing accounts once the overall deadline passes (A-API-13)", async () => {
    accountsList.mockResolvedValueOnce(accountPage(["1", "2"]));
    propertiesList.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return propertyPage(["10"]);
    });
    const out = await listGa4Properties(auth, { timeoutMs: 50 });
    // The first account's listing takes ~100ms; the deadline (50ms)
    // fires before the second account is attempted.
    expect(out.items).toHaveLength(1);
    expect(out.truncated).toBe(true);
    expect(propertiesList).toHaveBeenCalledTimes(1);
  });
});

describe("listAdSenseAccounts pagination", () => {
  it("follows nextPageToken", async () => {
    adsenseList
      .mockResolvedValueOnce({ data: { accounts: [{ name: "accounts/pub-1" }], nextPageToken: "n2" } })
      .mockResolvedValueOnce({ data: { accounts: [{ name: "accounts/pub-2" }] } });
    const out = await listAdSenseAccounts(auth);
    expect(out.items.map((a) => a.accountId)).toEqual(["pub-1", "pub-2"]);
    expect(out.truncated).toBe(false);
  });
});

describe("listSearchConsoleSites", () => {
  it("returns items with truncated=false (API has no pagination)", async () => {
    sitesList.mockResolvedValueOnce({
      data: { siteEntry: [{ siteUrl: "https://example.com/", permissionLevel: "siteOwner" }] },
    });
    const out = await listSearchConsoleSites(auth);
    expect(out.items).toEqual([{ siteUrl: "https://example.com/", permissionLevel: "siteOwner" }]);
    expect(out.truncated).toBe(false);
  });

  it("caps sites at 1000 and flags truncated (A-API-13)", async () => {
    const entries = Array.from({ length: 1001 }, (_, i) => ({
      siteUrl: `https://site${i}.example/`,
      permissionLevel: "siteOwner",
    }));
    sitesList.mockResolvedValueOnce({ data: { siteEntry: entries } });
    const out = await listSearchConsoleSites(auth);
    expect(out.items).toHaveLength(1000);
    expect(out.truncated).toBe(true);
  });
});
