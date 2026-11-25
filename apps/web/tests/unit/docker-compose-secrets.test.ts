import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// A-SEC-12: docker-compose.yml used to ship a default Postgres password
// (`POSTGRES_PASSWORD: analytics`) and publish the DB/Redis ports on all
// interfaces. It is a dev-only file, but a copy on a shared host would
// have exposed the database trivially. This test is the finding's static
// check: it reads the repo-root compose file and asserts no default
// credential survives and every published port is localhost-bound.
// It runs in the unit suite, which runs in CI.
const composePath = path.resolve(process.cwd(), "..", "..", "docker-compose.yml");
const text = fs.readFileSync(composePath, "utf8");

describe("docker-compose.yml secrets (A-SEC-12)", () => {
  it("has no hardcoded POSTGRES_PASSWORD value", () => {
    const line = text.split("\n").find((l) => l.includes("POSTGRES_PASSWORD:"));
    expect(line).toBeDefined();
    // The password must come from the environment; the ${...:?} form makes
    // compose fail loudly when it is unset instead of falling back.
    expect(line).toContain("${POSTGRES_PASSWORD:");
    expect(line).not.toContain("analytics");
  });

  it("binds every published port to localhost", () => {
    // No bare "5432:5432" / "6379:6379" (all interfaces) anywhere in the
    // file — every host:container mapping must be preceded by 127.0.0.1.
    expect(text).not.toMatch(/(?<!127\.0\.0\.1:)\d{4,5}:\d{4,5}/);
    const mappings = [...text.matchAll(/"([^"]+:[^"]+)"/g)].map((m) => m[1]);
    expect(mappings.length).toBeGreaterThan(0);
    for (const mapping of mappings) {
      expect(mapping.startsWith("127.0.0.1:")).toBe(true);
    }
    expect(text).toContain("127.0.0.1:5432:5432");
    expect(text).toContain("127.0.0.1:6379:6379");
  });

  it("carries a dev-only header explaining the env var", () => {
    expect(text).toMatch(/DEV-ONLY/i);
    expect(text).toContain("POSTGRES_PASSWORD");
    expect(text).toMatch(/never use this file on a shared or production host/i);
  });
});
