// Server-side better-auth setup (Phase 1 rework).
//
// Replaces the old custom cookie session + bcryptjs implementation.
// better-auth owns password hashing (scrypt, in its Account model) and
// session tokens; this module only exposes the helpers the rest of the
// app already uses: `auth`, `getSessionUser()` and `requireAuth()`.
//
// Env: BETTER_AUTH_SECRET (preferred) falls back to SESSION_SECRET.
// NEXT_PUBLIC_APP_URL is the public base URL (default http://localhost:3000).
import { headers } from "next/headers";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@metricflock/db";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  secret: process.env.BETTER_AUTH_SECRET ?? process.env.SESSION_SECRET,
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days, as before
    updateAge: 60 * 60 * 24, // refresh the session cookie at most once a day
  },
  user: {
    additionalFields: {
      // Exposed on the session user object so callers can read them
      // without a second DB query; the DB source of truth stays Prisma.
      role: { type: "string", required: false },
      organizationId: { type: "string", required: false },
    },
  },
});

// better-auth's session cookie name (kept exported for any caller that
// used to reference the old custom cookie name).
export const SESSION_COOKIE = "better-auth.session_token";

/** The signed-in Prisma user, or null. Reads the better-auth session cookie. */
export async function getSessionUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  return prisma.user.findUnique({ where: { id: session.user.id } });
}

export async function requireAuth() {
  const user = await getSessionUser();
  if (!user) throw new Error("UNAUTHENTICATED");
  return user;
}

/** Revoke the current session. The caller must forward the Set-Cookie
 *  header from the returned Response (the logout route does this). */
export async function destroySession() {
  return auth.api.signOut({ headers: await headers(), asResponse: true });
}
