import { describe, it, expect } from "vitest";
import {
  ALL_SCOPES,
  IDENTITY_SCOPES,
  GA4_SCOPES,
  GSC_SCOPES,
  ADSENSE_SCOPES,
  AD_MANAGER_SCOPES,
  missingScopesForProvider,
  providersMissingScopes,
} from "@metricflock/google/oauth";

// Phase 2 (F-2.1): scope correctness for the Google connect flow.
describe("OAuth scope sets", () => {
  it("connect scopes include the identity scopes userinfo requires (F-2.1a)", () => {
    for (const s of IDENTITY_SCOPES) expect(ALL_SCOPES).toContain(s);
    expect(ALL_SCOPES).toContain("openid");
    expect(ALL_SCOPES).toContain("email");
  });
  it("connect scopes include the three base provider scopes", () => {
    for (const s of [...GA4_SCOPES, ...GSC_SCOPES, ...ADSENSE_SCOPES]) expect(ALL_SCOPES).toContain(s);
  });
  it("Ad Manager scope is NOT in the base set (incremental, F-2.1b)", () => {
    for (const s of AD_MANAGER_SCOPES) expect(ALL_SCOPES).not.toContain(s);
  });
});

describe("missingScopesForProvider (F-2.1c)", () => {
  it("returns [] when the provider scope was granted", () => {
    expect(missingScopesForProvider([...ALL_SCOPES], "GA4")).toEqual([]);
    expect(missingScopesForProvider([...ALL_SCOPES], "SEARCH_CONSOLE")).toEqual([]);
    expect(missingScopesForProvider([...ALL_SCOPES], "ADSENSE")).toEqual([]);
  });
  it("returns the missing scope when it was not granted", () => {
    const granted = ALL_SCOPES.filter((s) => !GA4_SCOPES.includes(s));
    expect(missingScopesForProvider(granted, "GA4")).toEqual(GA4_SCOPES);
  });
  it("treats an empty grant as missing everything", () => {
    expect(missingScopesForProvider([], "ADSENSE")).toEqual(ADSENSE_SCOPES);
  });
});

describe("providersMissingScopes (F-2.1d)", () => {
  it("is empty for a full grant (Ad Manager disabled)", () => {
    expect(providersMissingScopes([...ALL_SCOPES], { adManagerEnabled: false })).toEqual([]);
  });
  it("flags Ad Manager only when the feature is enabled", () => {
    expect(providersMissingScopes([...ALL_SCOPES], { adManagerEnabled: true })).toEqual(["AD_MANAGER"]);
    expect(providersMissingScopes([...ALL_SCOPES, ...AD_MANAGER_SCOPES], { adManagerEnabled: true })).toEqual([]);
  });
  it("flags each provider missing its scope", () => {
    const granted = [...IDENTITY_SCOPES, ...GA4_SCOPES];
    expect(providersMissingScopes(granted, { adManagerEnabled: false })).toEqual(["SEARCH_CONSOLE", "ADSENSE"]);
  });
});
