import { describe, it, expect, vi, afterEach } from "vitest";
import { writeAudit, normalizeAuditIp } from "@metricflock/db/audit";

// A-SEC-16: audit `ipAddress` must store the single trusted client IP
// (the A-SEC-05 rule), never the raw attacker-controlled
// `x-forwarded-for` chain. The stored value is asserted through
// writeAudit's transaction path with a fake tx client — no database
// needed (the tx parameter is the A-DB-09 injection point).
function fakeTx() {
  const create = vi.fn((args: { data: { ipAddress?: string | undefined } }): Promise<unknown> => Promise.resolve({}));
  return { create, tx: { auditLog: { create } } as unknown as Parameters<typeof writeAudit>[1] };
}

async function storedIp(ipAddress: string | undefined) {
  const { create, tx } = fakeTx();
  await writeAudit({ organizationId: "org1", actorId: "u1", action: "test.action", ipAddress }, tx);
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0]?.[0].data.ipAddress;
}

describe("writeAudit ipAddress normalization (A-SEC-16)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores only the first (trusted client) entry of a spoofed chain", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(await storedIp("1.2.3.4, 5.6.7.8")).toBe("1.2.3.4");
  });

  it("stores the same trusted IP regardless of spoofed trailing entries", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(await storedIp("1.2.3.4, 5.6.7.8")).toBe(await storedIp("1.2.3.4, 9.9.9.9"));
  });

  it("passes a single IP through unchanged", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(await storedIp("203.0.113.7")).toBe("203.0.113.7");
  });

  it("stores 'unknown' instead of any header value when the proxy is not trusted", async () => {
    vi.stubEnv("TRUST_PROXY", "0");
    expect(await storedIp("1.2.3.4, 5.6.7.8")).toBe("unknown");
    expect(await storedIp("203.0.113.7")).toBe("unknown");
  });

  it("keeps rows without an IP address IP-less", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(await storedIp(undefined)).toBeUndefined();
  });

  it("normalizeAuditIp is idempotent for already-normalized values", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(normalizeAuditIp("unknown")).toBe("unknown");
    expect(normalizeAuditIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeAuditIp(undefined)).toBeUndefined();
  });
});
