// Server startup validation (runs once when the Next.js server boots,
// before it serves traffic). Fails closed: a deployment with missing or
// weak secrets must refuse to start instead of running with library
// defaults (better-auth falls back to a published default secret when
// none is configured — that must never reach production).
import { getEnv, createLogger } from "@metricflock/shared";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Throws with a readable message when DATABASE_URL is missing or
  // SESSION_SECRET / BETTER_AUTH_SECRET are unset or shorter than 32.
  getEnv();
  if (process.env.NODE_ENV === "production") {
    if (!process.env.NEXT_PUBLIC_APP_URL) {
      throw new Error(
        "NEXT_PUBLIC_APP_URL is not configured. In production the public base URL must be set explicitly (auth redirects and OAuth callbacks are derived from it).",
      );
    }
    if (!process.env.SMTP_HOST) {
      createLogger("startup").warn(
        "SMTP_HOST is not configured: email verification and password-reset emails will be logged to the server console instead of sent. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM to enable real delivery.",
      );
    }
  }
}
