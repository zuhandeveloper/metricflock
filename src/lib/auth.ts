// Backwards-compatible re-export: everything that imported "@/lib/auth"
// keeps working. The implementation lives in ./auth-server (better-auth).
export { auth, SESSION_COOKIE, getSessionUser, requireAuth, destroySession } from "./auth-server";
