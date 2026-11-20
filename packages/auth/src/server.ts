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

// Google sign-in (social login) uses the same Google Cloud app as the data
// connections. Only enabled when both credentials are configured, so the app
// still boots without them. The callback URL to register in Google Cloud
// Console is {NEXT_PUBLIC_APP_URL}/api/auth/callback/google.
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  ...(googleClientId && googleClientSecret
    ? { socialProviders: { google: { clientId: googleClientId, clientSecret: googleClientSecret } } }
    : {}),
  account: {
    // A Google login whose email matches an existing user signs into that
    // user (Google emails are verified) instead of creating a duplicate.
    accountLinking: { enabled: true, trustedProviders: ["google"] },
  },
  databaseHooks: {
    user: {
      create: {
        // User.organizationId is required, so a self sign-up (Google or
        // email) gets a fresh organization and becomes its SUPER_ADMIN.
        // Seed/invite flows create users through Prisma directly and never
        // reach this hook.
        before: async (user) => {
          const u = user as typeof user & { organizationId?: string; role?: string };
          if (u.organizationId) return { data: user };
          const base = (u.name || u.email.split("@")[0] || "workspace").trim();
          const slugBase = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
          const org = await prisma.organization.create({
            data: { name: `${base}'s workspace`, slug: `${slugBase}-${Math.random().toString(36).slice(2, 8)}` },
          });
          return { data: { ...user, organizationId: org.id, role: "SUPER_ADMIN" } };
        },
      },
    },
  },
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
