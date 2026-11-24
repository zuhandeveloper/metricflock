// Shared e2e constants (Phase 8). Kept out of the .setup.ts file
// because Playwright forbids importing one test file from another.
export const DEMO_EMAIL = "demo@example.com";
// The seed guard (A-SEC-03) removed the default demo password: the seed
// uses SEED_DEMO_ADMIN_PASSWORD, and the smoke script hands the generated
// value to later CI steps via GITHUB_ENV. Local runs fall back to the
// old default (seed locally with that same password).
export const DEMO_PASSWORD = process.env.SEED_DEMO_ADMIN_PASSWORD ?? "ChangeMe123!";
export const STORAGE_STATE = "tests/e2e/.auth/demo.json";
