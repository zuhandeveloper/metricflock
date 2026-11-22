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
});
