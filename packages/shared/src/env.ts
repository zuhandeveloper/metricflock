import { z } from "zod";
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),
  // better-auth secret (preferred by packages/auth/src/server.ts; falls
  // back to SESSION_SECRET when unset). Must also be >= 32 chars when set.
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 chars").optional(),
  // Transactional mail (email verification / password reset). Optional at
  // schema level; production startup warns when unset (see instrumentation).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_ANALYTICS_ENABLED: z.string().optional(),
  GOOGLE_SEARCH_CONSOLE_ENABLED: z.string().optional(),
  GOOGLE_ADSENSE_ENABLED: z.string().optional(),
  GOOGLE_AD_MANAGER_ENABLED: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().optional(),
});
export type Env = z.infer<typeof envSchema>;
let cached: Env | null = null;
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // During build/prisma generate, DATABASE_URL may be a placeholder; fail loudly at runtime use instead.
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return {
        DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5432/placeholder",
        SESSION_SECRET: "build-placeholder-secret-32-chars-long!!",
      } as Env;
    }
    throw new Error(
      "Invalid environment: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  cached = parsed.data;
  return cached;
}
export function googleEnabled(provider: "ANALYTICS" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER"): boolean {
  const e = process.env;
  const v = {
    ANALYTICS: e.GOOGLE_ANALYTICS_ENABLED,
    SEARCH_CONSOLE: e.GOOGLE_SEARCH_CONSOLE_ENABLED,
    ADSENSE: e.GOOGLE_ADSENSE_ENABLED,
    AD_MANAGER: e.GOOGLE_AD_MANAGER_ENABLED,
  }[provider];
  return v !== "false";
}
