import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// POST /api/profile/set-password: lets a Google-only account set a
// first password via better-auth's serverOnly setPassword endpoint.
// The route must require a session, enforce a fresh session (step-up,
// A-SEC-02 pattern), validate the password, and map better-auth's
// APIError codes honestly — without ever echoing the password.
const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
  requireFreshSession: vi.fn(),
  setPassword: vi.fn(),
}));

vi.mock("@metricflock/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireFreshSession: mocks.requireFreshSession,
  auth: { api: { setPassword: mocks.setPassword } },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import { POST } from "@/app/api/profile/set-password/route";

const user = { id: "u1", organizationId: "org1", role: "SUPER_ADMIN", email: "admin@example.com" };

function req(body: unknown) {
  return new NextRequest("http://localhost/api/profile/set-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An error shaped like better-auth's APIError (body.code). */
function apiError(code: string) {
  return Object.assign(new Error(code), { body: { code, message: code }, statusCode: 400 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiAuth.mockResolvedValue({ user });
  mocks.requireFreshSession.mockResolvedValue({ ok: true });
  mocks.setPassword.mockResolvedValue({ status: true });
});

describe("POST /api/profile/set-password", () => {
  it("returns 401 without a session and never calls setPassword", async () => {
    mocks.requireApiAuth.mockResolvedValue({
      error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }),
    });
    const res = await POST(req({ newPassword: "long-enough-password" }));
    expect(res.status).toBe(401);
    expect(mocks.setPassword).not.toHaveBeenCalled();
  });

  it("returns 401 session_not_fresh for a stale session and never calls setPassword", async () => {
    mocks.requireFreshSession.mockResolvedValue({
      error: NextResponse.json(
        { error: "session_not_fresh", message: "Please sign in again to continue." },
        { status: 401 },
      ),
    });
    const res = await POST(req({ newPassword: "long-enough-password" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("session_not_fresh");
    expect(mocks.setPassword).not.toHaveBeenCalled();
  });

  it("rejects a missing, non-string or too-short password with 400", async () => {
    for (const body of [{}, { newPassword: 123456789012 }, { newPassword: "short" }]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_password");
      expect(json.requestId).toEqual(expect.any(String));
    }
    expect(mocks.setPassword).not.toHaveBeenCalled();
  });

  it("sets the password via auth.api.setPassword and returns ok", async () => {
    const res = await POST(req({ newPassword: "long-enough-password" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    expect(mocks.setPassword).toHaveBeenCalledWith({
      body: { newPassword: "long-enough-password" },
      headers: expect.any(Headers),
    });
  });

  it("maps PASSWORD_ALREADY_SET to a 400 password_already_set", async () => {
    mocks.setPassword.mockRejectedValue(apiError("PASSWORD_ALREADY_SET"));
    const res = await POST(req({ newPassword: "long-enough-password" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("password_already_set");
    expect(body.details.message).toMatch(/already set/);
    // The submitted password must never be echoed back.
    expect(JSON.stringify(body)).not.toContain("long-enough-password");
  });

  it("maps SESSION_NOT_FRESH from better-auth to 401 session_not_fresh", async () => {
    mocks.setPassword.mockRejectedValue(apiError("SESSION_NOT_FRESH"));
    const res = await POST(req({ newPassword: "long-enough-password" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("session_not_fresh");
    expect(body.details.message).toMatch(/sign in again/);
  });

  it("maps PASSWORD_TOO_LONG to a 400 invalid_password", async () => {
    mocks.setPassword.mockRejectedValue(apiError("PASSWORD_TOO_LONG"));
    const res = await POST(req({ newPassword: "x".repeat(200) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_password");
  });

  it("turns an unexpected failure into a 500 internal_error", async () => {
    mocks.setPassword.mockRejectedValue(new Error("db down"));
    const res = await POST(req({ newPassword: "long-enough-password" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error", requestId: expect.any(String) });
  });
});
