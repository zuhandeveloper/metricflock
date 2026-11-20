import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "./server";

// Standard better-auth mount point: /api/auth/sign-in/email,
// /api/auth/sign-out, /api/auth/session, ... The login page uses the
// /api/auth/login wrapper instead, but client flows use these directly.
// The route file (apps/web) re-exports GET/POST from here so that
// better-auth is only ever imported inside this package.
export const authHandler = toNextJsHandler(auth);
