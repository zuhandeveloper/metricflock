import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth-server";

// Standard better-auth mount point: /api/auth/sign-in/email,
// /api/auth/sign-out, /api/auth/session, ... The login page uses the
// /api/auth/login wrapper instead, but client flows use these directly.
export const { GET, POST } = toNextJsHandler(auth);
