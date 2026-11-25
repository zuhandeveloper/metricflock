import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A-GGL-20 (a): buildAuthUrl must support incremental authorization per
// provider — when the caller names the provider(s) being connected, the
// consent URL requests only the identity scopes plus those providers'
// required scopes, not the full ALL_SCOPES set. No provider intent =
// the generic all-provider connect (unchanged). Prisma is mocked;
// googleapis is real (same setup as google-oauth.test.ts).
const mocks = vi.hoisted(() => ({
  oAuthStateDeleteMany: vi.fn(),
  oAuthStateCreate: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    oAuthState: {
      deleteMany: mocks.oAuthStateDeleteMany,
      create: mocks.oAuthStateCreate,
    },
  },
}));

import { buildAuthUrl } from "@metricflock/google/oauth";

const OAUTH_ENV = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/google/oauth/callback",
};

const ANALYTICS = "https://www.googleapis.com/auth/analytics.readonly";
const WEBMASTERS = "https://www.googleapis.com/auth/webmasters.readonly";
const ADSENSE = "https://www.googleapis.com/auth/adsense.readonly";
const AD_MANAGER = "https://www.googleapis.com/auth/admanager.readonly";

async function scopesOf(url: string): Promise<string[]> {
  return new URL(url).searchParams.get("scope")!.split(" ");
}

describe("buildAuthUrl provider-scoped consent (A-GGL-20)", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SESSION_SECRET", "test-session-secret-min-32-chars-long!!");
    vi.stubEnv("GOOGLE_CLIENT_ID", OAUTH_ENV.GOOGLE_CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", OAUTH_ENV.GOOGLE_CLIENT_SECRET);
    vi.stubEnv("GOOGLE_REDIRECT_URI", OAUTH_ENV.GOOGLE_REDIRECT_URI);
    mocks.oAuthStateDeleteMany.mockResolvedValue({ count: 0 });
    mocks.oAuthStateCreate.mockResolvedValue({ id: "flow-1" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...savedEnv };
  });

  it("GA4-only intent requests no AdSense or Search Console scope", async () => {
    const scopes = await scopesOf(
      await buildAuthUrl({ id: "user-1", organizationId: "org-1" }, "TEAM", "team-1", [], {
        providers: ["GA4"],
      }),
    );
    expect(scopes).toContain("openid");
    expect(scopes).toContain("email");
    expect(scopes).toContain(ANALYTICS);
    expect(scopes).not.toContain(ADSENSE);
    expect(scopes).not.toContain(WEBMASTERS);
    expect(scopes).not.toContain(AD_MANAGER);
  });

  it("multi-provider intent requests exactly those providers' scopes", async () => {
    const scopes = await scopesOf(
      await buildAuthUrl({ id: "user-1", organizationId: "org-1" }, "TEAM", "team-1", [], {
        providers: ["GA4", "ADSENSE"],
      }),
    );
    expect(scopes).toContain(ANALYTICS);
    expect(scopes).toContain(ADSENSE);
    expect(scopes).not.toContain(WEBMASTERS);
  });

  it("Ad Manager intent requests the Ad Manager scope without the others", async () => {
    const scopes = await scopesOf(
      await buildAuthUrl({ id: "user-1", organizationId: "org-1" }, "TEAM", "team-1", [], {
        providers: ["AD_MANAGER"],
      }),
    );
    expect(scopes).toContain(AD_MANAGER);
    expect(scopes).toContain("openid");
    expect(scopes).not.toContain(ANALYTICS);
    expect(scopes).not.toContain(ADSENSE);
  });

  it("no provider intent keeps the generic all-provider scope set", async () => {
    const scopes = await scopesOf(await buildAuthUrl({ id: "user-1", organizationId: "org-1" }, "TEAM", "team-1"));
    expect(scopes).toContain(ANALYTICS);
    expect(scopes).toContain(WEBMASTERS);
    expect(scopes).toContain(ADSENSE);
  });

  it("an empty providers list is treated as no intent (all-provider connect)", async () => {
    const scopes = await scopesOf(
      await buildAuthUrl({ id: "user-1", organizationId: "org-1" }, "TEAM", "team-1", [], {
        providers: [],
      }),
    );
    expect(scopes).toContain(ANALYTICS);
    expect(scopes).toContain(WEBMASTERS);
    expect(scopes).toContain(ADSENSE);
  });

  it("extra scopes still merge (deduped) alongside a provider-scoped request", async () => {
    const scopes = await scopesOf(
      await buildAuthUrl({ id: "user-1", organizationId: "org-1" }, "TEAM", "team-1", ["openid"], {
        providers: ["SEARCH_CONSOLE"],
      }),
    );
    expect(scopes).toContain(WEBMASTERS);
    expect(scopes.filter((s) => s === "openid")).toHaveLength(1);
    expect(scopes).not.toContain(ADSENSE);
  });
});
