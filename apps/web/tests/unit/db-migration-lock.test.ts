import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// A-DB-15: packages/db/prisma/migrations/ had no migration_lock.toml, so
// `prisma migrate diff --from-migrations ./prisma/migrations --to-schema …`
// failed with "Could not determine the connector from the migrations
// directory (missing migration_lock.toml)" and the canonical
// migrations↔schema drift check could not run as documented. This test
// is the finding's static check: it reads the lock file and asserts the
// provider is pinned to postgresql. It runs in the unit suite, which
// runs in CI; the full drift check itself is a CI step (see the
// follow-up in the remediation plan — workflow files are owner-only).
const lockPath = path.resolve(
  process.cwd(),
  "..",
  "..",
  "packages",
  "db",
  "prisma",
  "migrations",
  "migration_lock.toml",
);
const text = fs.readFileSync(lockPath, "utf8");

describe("migration_lock.toml (A-DB-15)", () => {
  it("exists and pins the provider to postgresql", () => {
    expect(text).toMatch(/^provider\s*=\s*"postgresql"\s*$/m);
  });
});
