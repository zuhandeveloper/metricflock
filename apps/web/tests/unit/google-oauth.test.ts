import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// packages/google/src/oauth.ts — the parts not covered by
// oauth-state.test.ts / oauth-scopes.test.ts: getOAuthClient config
// guard, createOAuthFlow / consumeOAuthState DB paths, the account
// profile fetch, and buildAuthUrl. Prisma is mocked; googleapis is
// real except for the oauth2 userinfo call.
const mocks = vi.hoisted(() => ({
  oAuthStateDeleteMany: vi.fn(),
  oAuthStateCreate: vi.fn(),
  oAuthStateUpdateMany: vi.fn(),
  oAuthStateFindUnique: vi.fn(),
  userinfoGet: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    oAuthState: {
      deleteMany: mocks.oAuthStateDeleteMany,
      create: mocks.oAuthStateCreate,
      updateMany: mocks.oAuthStateUpdateMany,
      findUnique: mocks.oAuthStateFindUnique,
    },
  },
}));
vi.mock("googleapis", async (importOriginal) => {
  // googleapis is @metricflock/google's dependency, not the web app's,
  // so its types are not resolvable from here — treat it structurally.
  const actual = (await importOriginal()) as { google: Record<string, unknown> };
  return {
    ...actual,
    google: {
      ...actual.google,
      oauth2: () => ({ userinfo: { get: mocks.userinfoGet } }),
    },
  };
});

import {
  getOAuthClient,
  createOAuthFlow,
  consumeOAuthState,
  getGoogleAccountProfile,
  buildAuthUrl,
  parseState,
  OAUTH_STATE_TTL_MS,
} from "@metricflock/google/oauth";
import { hashToken, hmacState } from "@metricflock/shared";

const OAUTH_ENV = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_REDIRECT_URI: "http://localhost:3000/api/google/oauth/callback",
};

describe("getOAuthClient", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.stubEnv("GOOGLE_CLIENT_ID", OAUTH_ENV.GOOGLE_CLIENT_ID);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", OAUTH_ENV.GOOGLE_CLIENT_SECRET);
    vi.stubEnv("GOOGLE_REDIRECT_URI", OAUTH_ENV.GOOGLE_REDIRECT_URI);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...savedEnv };
  });

  it("builds an OAuth2 client from env when configured", () => {
    const client = getOAuthClient();
    expect(typeof client.generateAuthUrl).toBe("function");
    expect(typeof client.setCredentials).toBe("function");
  });

  it.each(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"])(
    "throws GOOGLE_OAUTH_NOT_CONFIGURED when %s is missing",
    (name) => {
      delete process.env[name];
      expect(() => getOAuthClient()).toThrow("GOOGLE_OAUTH_NOT_CONFIGURED");
    },
  );
});

describe("createOAuthFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SESSION_SECRET", "test-session-secret-min-32-chars-long!!");
    mocks.oAuthStateDeleteMany.mockResolvedValue({ count: 0 });
    mocks.oAuthStateCreate.mockResolvedValue({ id: "flow-1" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("persists a single-use state record and returns a signed state + S256 challenge", async () => {
    const { state, codeChallenge } = await createOAuthFlow({
      userId: "user-1",
      organizationId: "org-1",
      ownerType: "TEAM",
      ownerId: "team-1",
    });
    expect(mocks.oAuthStateDeleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
    expect(mocks.oAuthStateCreate).toHaveBeenCalledTimes(1);
    const data = mocks.oAuthStateCreate.mock.calls[0][0].data;
    expect(data.userId).toBe("user-1");
    expect(data.organizationId).toBe("org-1");
    expect(data.ownerType).toBe("TEAM");
    expect(data.ownerId).toBe("team-1");
    expect(data.nonceHash).toHaveLength(64);
    expect(data.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(OAUTH_STATE_TTL_MS - 5000);
    // The challenge is the S256 of the stored verifier, and the state
    // round-trips to the nonce whose hash was stored.
    expect(codeChallenge).toBe(crypto.createHash("sha256").update(data.codeVerifier).digest("base64url"));
    expect(hashToken(parseState(state).nonce)).toBe(data.nonceHash);
  });

  it("still creates the flow when opportunistic cleanup fails", async () => {
    mocks.oAuthStateDeleteMany.mockRejectedValue(new Error("db hiccup"));
    const out = await createOAuthFlow({
      userId: "user-1",
      organizationId: "org-1",
      ownerType: "WEBSITE",
      ownerId: "site-1",
    });
    expect(out.state).toBeTruthy();
    expect(mocks.oAuthStateCreate).toHaveBeenCalledTimes(1);
  });
});

describe("consumeOAuthState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const record = {
    id: "flow-1",
    userId: "user-1",
    organizationId: "org-1",
    ownerType: "TEAM" as const,
    ownerId: "team-1",
    codeVerifier: "verifier-abc",
  };

  it("atomically consumes a live record and returns it", async () => {
    mocks.oAuthStateUpdateMany.mockResolvedValue({ count: 1 });
    mocks.oAuthStateFindUnique.mockResolvedValue(record);
    await expect(consumeOAuthState("nonce-123")).resolves.toEqual(record);
    expect(mocks.oAuthStateUpdateMany).toHaveBeenCalledWith({
      where: { nonceHash: hashToken("nonce-123"), consumedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { consumedAt: expect.any(Date) },
    });
    expect(mocks.oAuthStateFindUnique).toHaveBeenCalledWith({ where: { nonceHash: hashToken("nonce-123") } });
  });

  it("returns null for an unknown, expired, or already-consumed nonce", async () => {
    mocks.oAuthStateUpdateMany.mockResolvedValue({ count: 0 });
    await expect(consumeOAuthState("nonce-123")).resolves.toBeNull();
    expect(mocks.oAuthStateFindUnique).not.toHaveBeenCalled();
  });

  it("returns null when the record vanishes between consume and read", async () => {
    mocks.oAuthStateUpdateMany.mockResolvedValue({ count: 1 });
    mocks.oAuthStateFindUnique.mockResolvedValue(null);
    await expect(consumeOAuthState("nonce-123")).resolves.toBeNull();
  });
});

describe("parseState — malformed shapes", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-min-32-chars-long!!");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a payload that is not a string", () => {
    const state = Buffer.from(JSON.stringify({ payload: 123, sig: "x" })).toString("base64url");
    expect(() => parseState(state)).toThrow("INVALID_STATE");
  });

  it("rejects a signature that is not a string", () => {
    const state = Buffer.from(JSON.stringify({ payload: JSON.stringify({ nonce: "x" }), sig: 42 })).toString(
      "base64url",
    );
    expect(() => parseState(state)).toThrow("INVALID_STATE");
  });

  it("rejects a payload that is not valid JSON", () => {
    const payload = "not-json";
    const state = Buffer.from(JSON.stringify({ payload, sig: hmacState(payload) })).toString("base64url");
    expect(() => parseState(state)).toThrow("INVALID_STATE");
  });

  it("rejects a missing or empty nonce", () => {
    for (const nonce of [undefined, "", 42]) {
      const payload = JSON.stringify(nonce === undefined ? {} : { nonce });
      const state = Buffer.from(JSON.stringify({ payload, sig: hmacState(payload) })).toString("base64url");
      expect(() => parseState(state)).toThrow("INVALID_STATE");
    }
  });
});

describe("getGoogleAccountProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the Google account email and id", async () => {
    mocks.userinfoGet.mockResolvedValue({ data: { email: "owner@example.com", id: "google-123" } });
    const client = {} as never;
    await expect(getGoogleAccountProfile(client)).resolves.toEqual({
      email: "owner@example.com",
      id: "google-123",
    });
    expect(mocks.userinfoGet).toHaveBeenCalledTimes(1);
  });

  it("throws GOOGLE_PROFILE_EMAIL_MISSING when userinfo returns no email (A-GGL-18)", async () => {
    // The old unknown@google fallback could collide two different
    // Google accounts on one connection row (the callback upserts on
    // googleAccountEmail) and silently overwrite each other's tokens.
    mocks.userinfoGet.mockResolvedValue({ data: { id: "google-123" } });
    await expect(getGoogleAccountProfile({} as never)).rejects.toThrow("GOOGLE_PROFILE_EMAIL_MISSING");
  });
});

describe("buildAuthUrl", () => {
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

  it("builds an offline consent URL with PKCE, state, and the full scope set", async () => {
    const url = new URL(await buildAuthUrl({ id: "user-1", organizationId: "org-1" }, "TEAM", "team-1"));
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("openid");
    expect(scopes).toContain("email");
    expect(scopes).toContain("https://www.googleapis.com/auth/analytics.readonly");
    expect(scopes).toContain("https://www.googleapis.com/auth/webmasters.readonly");
    expect(scopes).toContain("https://www.googleapis.com/auth/adsense.readonly");
    // The state parameter is a signed nonce for the persisted flow.
    const { nonce } = parseState(url.searchParams.get("state")!);
    expect(hashToken(nonce)).toBe(mocks.oAuthStateCreate.mock.calls[0][0].data.nonceHash);
    expect(mocks.oAuthStateCreate.mock.calls[0][0].data.ownerType).toBe("TEAM");
    expect(mocks.oAuthStateCreate.mock.calls[0][0].data.ownerId).toBe("team-1");
  });

  it("merges extra scopes without duplicates", async () => {
    const url = new URL(
      await buildAuthUrl({ id: "user-1", organizationId: "org-1" }, "WEBSITE", "site-1", [
        "https://www.googleapis.com/auth/admanager.readonly",
        "openid",
      ]),
    );
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/admanager.readonly");
    expect(scopes.filter((s) => s === "openid")).toHaveLength(1);
  });
});
