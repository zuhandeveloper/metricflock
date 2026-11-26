import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, apiError } from "@/lib/api-error";
import { auth, requireApiAuth, requireFreshSession } from "@metricflock/auth";

// Set a first password for accounts that have none (Google sign-in).
// better-auth's setPassword is a serverOnly endpoint — it links a
// credential account when none exists — so it can only be called from
// server code (auth.api), never from the browser client. Adding a
// credential to an account is a sensitive mutation: like the other
// step-up routes (A-SEC-02) it requires a fresh session, so a stale
// session must re-authenticate first. The password itself is never
// logged or echoed back.
const MIN_PASSWORD_LENGTH = 12; // matches emailAndPassword.minPasswordLength

/** better-auth APIError code (`e.body.code`), read structurally — the
 *  boundary rules keep bare `better-auth` imports inside packages/auth,
 *  so no `instanceof APIError` here. */
function authErrorCode(e: unknown): string | null {
  const code = (e as { body?: { code?: unknown } } | null)?.body?.code;
  return typeof code === "string" ? code : null;
}

async function post(req: NextRequest) {
  const authz = await requireApiAuth(undefined, { req });
  if ("error" in authz) return authz.error;
  const fresh = await requireFreshSession();
  if ("error" in fresh) return fresh.error;
  const body = (await req.json().catch(() => ({}))) as { newPassword?: unknown };
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return apiError("invalid_password", 400, {
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  }
  try {
    await auth.api.setPassword({ body: { newPassword }, headers: await headers() });
  } catch (e) {
    switch (authErrorCode(e)) {
      case "PASSWORD_ALREADY_SET":
        return apiError("password_already_set", 400, {
          message: "A password is already set for this account. Use Change password instead.",
        });
      case "PASSWORD_TOO_SHORT":
      case "PASSWORD_TOO_LONG":
        return apiError("invalid_password", 400, {
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
      case "SESSION_NOT_FRESH":
      case "UNAUTHORIZED":
        return apiError("session_not_fresh", 401, { message: "Please sign in again to continue." });
      default:
        throw e;
    }
  }
  return NextResponse.json({ status: "ok" });
}

export const POST = withApiErrors("profile/set-password", post);
