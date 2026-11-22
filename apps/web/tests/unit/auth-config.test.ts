import { describe, it, expect } from "vitest";
import { auth } from "@metricflock/auth";

// Regression tests for the Stage 1 critical auth fixes (audit AUTH-1/2/3/9).
// These assert the better-auth configuration that closes the mass-assignment
// and account pre-hijacking vectors. The behavioral proof (real sign-up /
// update-user attempts against a live server + database) lives in
// scripts/smoke-test.sh, which runs in CI against real Postgres + Redis.
type AnyOptions = {
  user?: { additionalFields?: Record<string, { input?: boolean }> };
  emailAndPassword?: { requireEmailVerification?: boolean; minPasswordLength?: number };
  account?: { accountLinking?: { requireLocalEmailVerified?: boolean } };
  databaseHooks?: { user?: { create?: { before?: unknown }; update?: { before?: unknown } } };
  rateLimit?: { enabled?: boolean; customRules?: Record<string, { window?: number; max?: number }> };
  advanced?: { useSecureCookies?: boolean };
};

const options = (auth as unknown as { options: AnyOptions }).options;

describe("better-auth security configuration", () => {
  it("role is not client-settable (input: false)", () => {
    expect(options.user?.additionalFields?.role?.input).toBe(false);
  });
  it("organizationId is not client-settable (input: false)", () => {
    expect(options.user?.additionalFields?.organizationId?.input).toBe(false);
  });
  it("password accounts require email verification", () => {
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
  });
  it("minimum password length is 12", () => {
    expect(options.emailAndPassword?.minPasswordLength).toBe(12);
  });
  it("provider linking requires a verified local email", () => {
    expect(options.account?.accountLinking?.requireLocalEmailVerified).toBe(true);
  });
  it("user create and update hooks are registered", () => {
    expect(typeof options.databaseHooks?.user?.create?.before).toBe("function");
    expect(typeof options.databaseHooks?.user?.update?.before).toBe("function");
  });
  it("rate limiting is explicitly enabled with strict credential rules (F-2.5)", () => {
    expect(options.rateLimit?.enabled).toBe(true);
    expect(options.rateLimit?.customRules?.["/sign-in/email"]).toEqual({ window: 10, max: 3 });
    expect(options.rateLimit?.customRules?.["/sign-up/email"]).toEqual({ window: 10, max: 3 });
    expect(options.rateLimit?.customRules?.["/change-password"]).toEqual({ window: 10, max: 3 });
  });
  it("secure cookies are tied to production (F-2.5)", () => {
    expect(options.advanced?.useSecureCookies).toBe(process.env.NODE_ENV === "production");
  });
});
