import { authHandler } from "@metricflock/auth";

// Standard better-auth mount point: /api/auth/sign-in/email,
// /api/auth/sign-out, /api/auth/session, ... The login page uses the
// /api/auth/login wrapper instead, but client flows use these directly.
// The handler itself lives in @metricflock/auth so better-auth is only
// ever imported inside that package.
export const { GET, POST } = authHandler;
