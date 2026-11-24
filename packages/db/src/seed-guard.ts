// Seed target guard (A-SEC-03). Pure functions, no Prisma import —
// the seed script (`seed.ts`) imports the Prisma client, which throws
// at module load when DATABASE_URL is unset, so the guard itself must
// stay importable (and unit-testable) without a database.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
// Note: URL.hostname may keep IPv6 brackets ("[::1]") or strip them
// ("::1") depending on the parser — isLocalDatabaseUrl normalizes
// brackets away before this lookup, so only the bare form is needed.

/** True when the DATABASE_URL host is a local/dev host. Anything
 *  unparsable, missing, or non-local returns false (fail closed). */
export function isLocalDatabaseUrl(databaseUrl: string | null | undefined): boolean {
  if (!databaseUrl) return false;
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // WHATWG URL keeps IPv6 brackets in hostname ("[::1]") in Node, but
  // other parsers strip them ("::1") — normalize so the check does not
  // depend on which form the parser returns.
  hostname = hostname.replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  if (hostname.endsWith(".localhost")) return true;
  return false;
}

export type SeedGuardResult = { ok: true; password: string } | { ok: false; reason: string };

/** Decide whether the seed may run against the target database. The
 *  guard keys off the TARGET, not NODE_ENV (the old footgun: NODE_ENV
 *  unset + a remote DATABASE_URL created a known-credential SUPER_ADMIN
 *  in whatever database the URL pointed at):
 *  1. The demo admin password must come from SEED_DEMO_ADMIN_PASSWORD.
 *     There is no default — without it the seed refuses, in every env.
 *  2. The target must look local, unless SEED_ALLOW_REMOTE=1 is set
 *     explicitly for this run (e.g. seeding a staging DB on purpose). */
export function checkSeedTarget(opts: {
  databaseUrl?: string | null;
  allowRemote?: boolean;
  password?: string | null;
}): SeedGuardResult {
  const { databaseUrl, allowRemote = false, password } = opts;
  if (!password) {
    return {
      ok: false,
      reason:
        "refusing to seed: set SEED_DEMO_ADMIN_PASSWORD to create the demo admin with a private password (there is no default password).",
    };
  }
  if (!isLocalDatabaseUrl(databaseUrl) && !allowRemote) {
    return {
      ok: false,
      reason:
        "refusing to seed: DATABASE_URL points at a non-local host. Seed only against a local database, or set SEED_ALLOW_REMOTE=1 explicitly for this run.",
    };
  }
  return { ok: true, password };
}
