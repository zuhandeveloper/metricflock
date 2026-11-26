// A-SEC-08: two-factor enrolment policy (owner decision 2026-11-26).
//
// SUPER_ADMIN must enrol in 2FA before using the app; every other role
// only gets a non-blocking recommendation. The (app) layout enforces
// this: a gated SUPER_ADMIN sees the setup screen instead of page
// content (the sidebar — including sign-out — still renders).
//
// Activation: enforcement is on for production deployments only.
//   - Vercel production (VERCEL_ENV=production), or
//   - REQUIRE_SUPER_ADMIN_2FA=1 (explicit opt-in for any other host), or
//   - any other production Node process outside CI
//     (NODE_ENV=production with neither CI nor GITHUB_ACTIONS set).
// Local dev (NODE_ENV=development) and CI (seeded demo SUPER_ADMIN
// drives smoke/e2e page flows) are intentionally not gated; without
// this, CI's demo admin — a SUPER_ADMIN with no 2FA — could not load
// any app page. Production on Vercel always satisfies the first rule.

export type TwoFactorGateUser = { role: string; twoFactorEnabled: boolean };

/** True when this user must enrol in 2FA before using the app. */
export function requiresTwoFactorSetup(user: TwoFactorGateUser): boolean {
  return user.role === "SUPER_ADMIN" && !user.twoFactorEnabled;
}

/** True when this user should see the (non-blocking) 2FA recommendation. */
export function shouldNudgeTwoFactor(user: TwoFactorGateUser): boolean {
  return user.role !== "SUPER_ADMIN" && !user.twoFactorEnabled;
}

/** True when the enrolment policy is active in this deployment. */
export function twoFactorEnforcementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.REQUIRE_SUPER_ADMIN_2FA === "1") return true;
  if (env.VERCEL_ENV === "production") return true;
  return env.NODE_ENV === "production" && !env.CI && !env.GITHUB_ACTIONS;
}
