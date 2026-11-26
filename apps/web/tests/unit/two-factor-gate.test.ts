import { describe, expect, it } from "vitest";
import { requiresTwoFactorSetup, shouldNudgeTwoFactor, twoFactorEnforcementEnabled } from "@/lib/two-factor-gate";

// A-SEC-08 regression tests for the enrolment policy helper
// (owner decision 2026-11-26: mandatory for SUPER_ADMIN, recommended
// for every other role).

describe("requiresTwoFactorSetup", () => {
  it("requires setup for a SUPER_ADMIN without 2FA", () => {
    expect(requiresTwoFactorSetup({ role: "SUPER_ADMIN", twoFactorEnabled: false })).toBe(true);
  });

  it("does not require setup for a SUPER_ADMIN with 2FA enabled", () => {
    expect(requiresTwoFactorSetup({ role: "SUPER_ADMIN", twoFactorEnabled: true })).toBe(false);
  });

  it("never requires setup for non-SUPER_ADMIN roles", () => {
    expect(requiresTwoFactorSetup({ role: "TEAM_ADMIN", twoFactorEnabled: false })).toBe(false);
    expect(requiresTwoFactorSetup({ role: "TEAM_MEMBER", twoFactorEnabled: false })).toBe(false);
  });
});

describe("shouldNudgeTwoFactor", () => {
  it("nudges non-SUPER_ADMIN users without 2FA", () => {
    expect(shouldNudgeTwoFactor({ role: "TEAM_ADMIN", twoFactorEnabled: false })).toBe(true);
    expect(shouldNudgeTwoFactor({ role: "TEAM_MEMBER", twoFactorEnabled: false })).toBe(true);
  });

  it("does not nudge when 2FA is already enabled", () => {
    expect(shouldNudgeTwoFactor({ role: "TEAM_ADMIN", twoFactorEnabled: true })).toBe(false);
    expect(shouldNudgeTwoFactor({ role: "TEAM_MEMBER", twoFactorEnabled: true })).toBe(false);
  });

  it("does not nudge SUPER_ADMIN (they get the blocking gate instead)", () => {
    expect(shouldNudgeTwoFactor({ role: "SUPER_ADMIN", twoFactorEnabled: false })).toBe(false);
  });
});

describe("twoFactorEnforcementEnabled", () => {
  const env = (overrides: Record<string, string>) => overrides as NodeJS.ProcessEnv;

  it("is on for Vercel production", () => {
    expect(twoFactorEnforcementEnabled(env({ VERCEL_ENV: "production", NODE_ENV: "production" }))).toBe(true);
  });

  it("is on when explicitly opted in, even in development", () => {
    expect(twoFactorEnforcementEnabled(env({ REQUIRE_SUPER_ADMIN_2FA: "1", NODE_ENV: "development" }))).toBe(true);
  });

  it("is on for self-hosted production outside CI", () => {
    expect(twoFactorEnforcementEnabled(env({ NODE_ENV: "production" }))).toBe(true);
  });

  it("is off in CI (seeded demo SUPER_ADMIN drives smoke/e2e)", () => {
    expect(twoFactorEnforcementEnabled(env({ NODE_ENV: "production", CI: "true" }))).toBe(false);
    expect(twoFactorEnforcementEnabled(env({ NODE_ENV: "production", GITHUB_ACTIONS: "true" }))).toBe(false);
  });

  it("is off in local development and test", () => {
    expect(twoFactorEnforcementEnabled(env({ NODE_ENV: "development" }))).toBe(false);
    expect(twoFactorEnforcementEnabled(env({ NODE_ENV: "test" }))).toBe(false);
    expect(twoFactorEnforcementEnabled(env({ VERCEL_ENV: "preview", NODE_ENV: "production", CI: "true" }))).toBe(false);
  });
});
