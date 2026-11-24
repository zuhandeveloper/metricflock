import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Coverage-gap closure: POST /api/auth/login — thin wrapper around
// better-auth email sign-in. The better-auth client itself is mocked
// (auth.api.signInEmail); rate limiting is mocked via @metricflock/shared.
const mocks = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@metricflock/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/auth")>();
  return { ...actual, auth: { api: { signInEmail: mocks.signInEmail } } };
});
vi.mock("@metricflock/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@metricflock/shared")>();
  return { ...actual, rateLimit: mocks.rateLimit };
});

import { POST as loginPost } from "@/app/api/auth/login/route";

const url = "http://localhost/api/auth/login";
const jsonReq = (body: unknown) =>
  new NextRequest(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const okResponse = (payload: unknown, cookie?: string) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: cookie ? { "set-cookie": cookie } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
});

describe("POST /api/auth/login", () => {
  it("rate-limited → 429 too_many_requests", async () => {
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await loginPost(jsonReq({ email: "a@example.com", password: "x" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "too_many_requests" });
    expect(mocks.signInEmail).not.toHaveBeenCalled();
  });
  it("invalid input → 400 (bad email, empty password, missing body)", async () => {
    for (const body of [{ email: "nope", password: "x" }, { email: "a@example.com", password: "" }, {}]) {
      const res = await loginPost(jsonReq(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_input" });
    }
    expect(mocks.signInEmail).not.toHaveBeenCalled();
  });
  it("sign-in rejected → 401 invalid_credentials", async () => {
    mocks.signInEmail.mockResolvedValue(new Response(null, { status: 401 }));
    const res = await loginPost(jsonReq({ email: "a@example.com", password: "wrong-password" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_credentials" });
  });
  it("valid → 200 ok with user shape + forwards the session cookie", async () => {
    mocks.signInEmail.mockResolvedValue(
      okResponse(
        { user: { id: "u1", email: "a@example.com", name: "Ann", role: "SUPER_ADMIN" } },
        "better-auth.session_token=abc123; Path=/; HttpOnly",
      ),
    );
    const res = await loginPost(jsonReq({ email: "a@example.com", password: "correct-password-123" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      user: { id: "u1", email: "a@example.com", name: "Ann", role: "SUPER_ADMIN" },
    });
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=abc123");
    expect(mocks.signInEmail).toHaveBeenCalledWith(
      expect.objectContaining({ body: { email: "a@example.com", password: "correct-password-123" }, asResponse: true }),
    );
  });
  it("2FA pending → two_factor_required + forwards the pending-2FA cookie", async () => {
    mocks.signInEmail.mockResolvedValue(
      okResponse({ twoFactorRedirect: true }, "better-auth.two_factor=pending; Path=/; HttpOnly"),
    );
    const res = await loginPost(jsonReq({ email: "a@example.com", password: "correct-password-123" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "two_factor_required" });
    expect(res.headers.get("set-cookie")).toContain("better-auth.two_factor=pending");
  });
  it("sign-in ok without a user payload → 200 ok with no user field", async () => {
    mocks.signInEmail.mockResolvedValue(okResponse({}));
    const res = await loginPost(jsonReq({ email: "a@example.com", password: "correct-password-123" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
