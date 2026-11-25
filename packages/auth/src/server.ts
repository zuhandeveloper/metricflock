// Server-side better-auth setup (Phase 1 rework).
//
// Replaces the old custom cookie session + bcryptjs implementation.
// better-auth owns password hashing (scrypt, in its Account model) and
// session tokens; this module only exposes the helpers the rest of the
// app already uses: `auth`, `getSessionUser()` and `requireAuth()`.
//
// Env: BETTER_AUTH_SECRET (preferred) falls back to SESSION_SECRET.
// NEXT_PUBLIC_APP_URL is the public base URL (default http://localhost:3000).
import crypto from "node:crypto";
import { headers } from "next/headers";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { createLogger, errMeta } from "@metricflock/shared";
import { sendPasswordResetEmail, sendVerificationEmail } from "./mailer";

/** DB-10: auth events land in the same audit trail as app mutations.
 *  Audit failures must never break sign-in, so every write is best-effort. */
async function auditAuthEvent(userId: string, action: string, ipAddress?: string | null) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
    if (!user) return;
    await writeAudit({
      organizationId: user.organizationId,
      actorId: userId,
      action,
      entityType: "User",
      entityId: userId,
      ipAddress: ipAddress ?? undefined,
    });
  } catch (e) {
    createLogger("audit").error("auth event audit failed", errMeta(e));
  }
}

// Google sign-in (social login) uses the same Google Cloud app as the data
// connections. Only enabled when both credentials are configured, so the app
// still boots without them. The callback URL to register in Google Cloud
// Console is {NEXT_PUBLIC_APP_URL}/api/auth/callback/google.
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    // Password accounts must prove they own the email address before they
    // can sign in. Without this, anyone can register (squat) any email.
    requireEmailVerification: true,
    minPasswordLength: 12,
    // AUTH-10: a password reset kills every existing session — a reset is
    // the standard account-recovery path after a suspected compromise.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail(user.email, url);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail(user.email, url);
    },
  },
  ...(googleClientId && googleClientSecret
    ? { socialProviders: { google: { clientId: googleClientId, clientSecret: googleClientSecret } } }
    : {}),
  account: {
    // A Google login whose email matches an existing user signs into that
    // user (Google emails are verified) instead of creating a duplicate.
    // requireLocalEmailVerified: never link a provider account into a local
    // account whose email was not verified — that is the account
    // pre-hijacking vector (attacker pre-registers the victim's email with
    // a password, victim's Google sign-in would link into it).
    accountLinking: { enabled: true, trustedProviders: ["google"], requireLocalEmailVerified: true },
  },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          await auditAuthEvent(session.userId, "auth.sign_in", session.ipAddress);
        },
      },
    },
    user: {
      create: {
        // User.organizationId is required. Two paths:
        //  1. Invited sign-up: a pending OrganizationInvite matches the
        //     email (unexpired, unaccepted) → the user joins THAT
        //     organization with the invite's role.
        //  2. Self sign-up (Google or email) with no invite → a fresh
        //     organization, and the user becomes its SUPER_ADMIN.
        // Seed flows create users through Prisma directly and never
        // reach this hook.
        //
        // SECURITY: organizationId and role are ALWAYS assigned here,
        // server-side. Any client-supplied values are discarded (the
        // additionalFields below also set `input: false`, so better-auth
        // rejects them at the API boundary — this hook is the second
        // layer). Never trust a client-provided organizationId: that was
        // a cross-tenant takeover vector. The invite lookup is by the
        // account email; sign-in still requires a verified email
        // (email verification / Google), so matching an invite here
        // does not let anyone claim an invite for an inbox they do
        // not control.
        before: async (user) => {
          const invite = await prisma.organizationInvite.findFirst({
            where: {
              email: { equals: user.email, mode: "insensitive" },
              acceptedAt: null,
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
          });
          if (invite) {
            return { data: { ...user, organizationId: invite.organizationId, role: invite.role } };
          }
          const u = user as typeof user & { organizationId?: string; role?: string };
          const base = (u.name || u.email.split("@")[0] || "workspace").trim();
          const slugBase =
            base
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "") || "workspace";
          const org = await prisma.organization.create({
            data: {
              name: `${base}'s workspace`,
              slug: `${slugBase}-${crypto.randomBytes(4).toString("hex")}`,
            },
          });
          return { data: { ...user, organizationId: org.id, role: "SUPER_ADMIN" } };
        },
        after: async (user) => {
          // If this sign-up consumed an invite (see before-hook), mark
          // it accepted so it cannot be reused.
          const created = user as typeof user & { organizationId?: string };
          if (created.organizationId) {
            await prisma.organizationInvite
              .updateMany({
                where: {
                  email: { equals: user.email, mode: "insensitive" },
                  organizationId: created.organizationId,
                  acceptedAt: null,
                },
                data: { acceptedAt: new Date() },
              })
              .catch(() => undefined);
          }
          await auditAuthEvent(user.id, "auth.sign_up");
        },
      },
      update: {
        // SECURITY: role and organizationId must never change through a
        // user update (e.g. POST /api/auth/update-user). `input: false`
        // on the additionalFields already rejects them at the API
        // boundary; this hook is defense-in-depth for any other path
        // that reaches the adapter with those fields. Internal updates
        // (emailVerified flips, profile sync) never include them.
        before: async (user) => {
          const u = user as typeof user & { organizationId?: string; role?: string };
          if (u.organizationId !== undefined || u.role !== undefined) {
            throw new Error("role and organizationId cannot be changed through user update");
          }
          return { data: user };
        },
      },
    },
  },
  secret: process.env.BETTER_AUTH_SECRET ?? process.env.SESSION_SECRET,
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  // F-2.5: rate limits are pinned explicitly instead of relying on
  // library defaults (which can drift across better-auth upgrades).
  // Credential endpoints keep the strict 3-per-10s budget; everything
  // else gets a generous per-IP ceiling. Storage is better-auth's
  // in-memory store (per instance) — distributed limiting for the
  // app's own endpoints is handled separately (Phase 3, F-3.1).
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 10, max: 3 },
      "/sign-up/email": { window: 10, max: 3 },
      "/change-password": { window: 10, max: 3 },
      "/change-email": { window: 10, max: 3 },
    },
  },
  advanced: {
    // Secure cookies in production (F-2.5) — never send session cookies
    // over plain HTTP outside local development.
    useSecureCookies: process.env.NODE_ENV === "production",
    // A-SEC-16: session IPs feed the `auth.sign_in` audit rows (and the
    // Sessions UI). better-auth defaults to `x-forwarded-for` alone,
    // whose single entry any client can forge. Prefer `x-real-ip` — the
    // hosting platform sets it from the TCP connection, replacing any
    // client value (same preference order as A-SEC-05's
    // `clientIpFromHeaders`) — and fall back to the first
    // `x-forwarded-for` entry only when no platform header is present.
    ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days, as before
    updateAge: 60 * 60 * 24, // refresh the session cookie at most once a day
    // AUTH-11: sensitive operations (password/email change, 2FA toggle)
    // require a session fresher than 15 minutes.
    freshAge: 60 * 15,
  },
  plugins: [
    // TOTP two-factor authentication (Stage 7). Passkeys are a separate
    // increment (needs @better-auth/passkey + relying-party config).
    twoFactor({ issuer: "MetricFlock" }),
  ],
  user: {
    additionalFields: {
      // Exposed on the session user object so callers can read them
      // without a second DB query; the DB source of truth stays Prisma.
      // `input: false` is CRITICAL: without it, better-auth accepts these
      // fields from client input on sign-up and update-user, letting any
      // user self-assign SUPER_ADMIN or join a foreign organization.
      role: { type: "string", required: false, input: false },
      organizationId: { type: "string", required: false, input: false },
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

/** The raw better-auth session for the current request, or null. Unlike
 *  `getSessionUser` this keeps the session row itself — notably
 *  `session.createdAt`, which is the basis for freshness (step-up)
 *  checks in `requireFreshSession` (`api-helpers.ts`). */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
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
