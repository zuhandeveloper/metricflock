import { authHandler } from "@metricflock/auth";
import { withApiErrors } from "@/lib/api-error";

// Standard better-auth mount point: /api/auth/sign-in/email,
// /api/auth/sign-out, /api/auth/session, ... The login page uses the
// /api/auth/login wrapper instead, but client flows use these directly.
// The handler itself lives in @metricflock/auth so better-auth is only
// ever imported inside that package.
// A-API-02: wrapped in withApiErrors so a throw inside better-auth (e.g.
// a down database) returns the contract error instead of a framework 500.
// better-auth returns plain Responses for its own failures, which pass
// through unchanged (only thrown errors are converted).
export const GET = withApiErrors("auth", authHandler.GET);
export const POST = withApiErrors("auth", authHandler.POST);
