import path from "node:path";
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";

// A-COV-14: Prisma-call-shape tests for the DB write paths in
// packages/db/src/audit.ts (writeAudit) and packages/db/src/health.ts
// (recordHealth, lastSuccessfulSync). snapshots.ts write functions are
// already pinned by db-snapshots-seed.test.ts. Both target modules
// import the Prisma client through ./client, mocked here by computed
// absolute path (same pattern as db-snapshots-seed.test.ts: a relative
// vi.mock path resolves against the wrong base for files outside the
// web root and silently misses, so the mock is registered with
// vi.doMock and the modules are imported dynamically after it).
const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  healthUpsert: vi.fn(),
  syncFindFirst: vi.fn(),
}));

const CLIENT_PATH = path.resolve(process.cwd(), "../../packages/db/src/client.ts");
function registerClientMock() {
  vi.doMock(CLIENT_PATH, () => ({
    prisma: {
      auditLog: { create: mocks.auditCreate },
      integrationHealth: { upsert: mocks.healthUpsert },
      analyticsSyncJob: { findFirst: mocks.syncFindFirst },
    },
    Prisma: {},
  }));
}

type AuditModule = typeof import("@metricflock/db/audit");
type HealthModule = typeof import("@metricflock/db/health");
let audit: AuditModule;
let health: HealthModule;

beforeAll(async () => {
  registerClientMock();
  vi.resetModules();
  audit = await import("@metricflock/db/audit");
  health = await import("@metricflock/db/health");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditCreate.mockResolvedValue({});
  mocks.healthUpsert.mockResolvedValue({ id: "h-1" });
  mocks.syncFindFirst.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeTx() {
  const create = vi.fn((args: { data: Record<string, unknown> }): Promise<unknown> => Promise.resolve({}));
  return { create, tx: { auditLog: { create } } as unknown as Parameters<AuditModule["writeAudit"]>[1] };
}

describe("writeAudit (packages/db/src/audit.ts)", () => {
  it("tx path: creates the audit row with the exact data shape (details scrubbed, IP normalized)", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const { create, tx } = fakeTx();
    await audit.writeAudit(
      {
        organizationId: "org1",
        actorId: "u1",
        action: "website.transfer.accepted",
        entityType: "Website",
        entityId: "w1",
        details: { teamId: "t1", accessToken: "secret-value", note: "ok" },
        ipAddress: "203.0.113.7",
        requestId: "req-1",
      },
      tx,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: "org1",
        actorId: "u1",
        action: "website.transfer.accepted",
        entityType: "Website",
        entityId: "w1",
        // DB-10: the credential-looking key is dropped at the write
        // boundary, not left to callers.
        details: { teamId: "t1", note: "ok" },
        ipAddress: "203.0.113.7",
        requestId: "req-1",
      },
    });
    // The tx path must not touch the module-level client (A-DB-09:
    // the row commits or rolls back with the caller's transaction).
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("tx path: omitted actorId stores null, omitted details/entity/request store undefined", async () => {
    const { create, tx } = fakeTx();
    await audit.writeAudit({ organizationId: "org1", action: "org.created" }, tx);
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]![0].data;
    expect(data.organizationId).toBe("org1");
    expect(data.actorId).toBeNull();
    expect(data.action).toBe("org.created");
    expect(data.entityType).toBeUndefined();
    expect(data.entityId).toBeUndefined();
    expect(data.details).toBeUndefined();
    expect(data.ipAddress).toBeUndefined();
    expect(data.requestId).toBeUndefined();
  });

  it("tx path: a create failure propagates (A-DB-09 — the transaction must roll back)", async () => {
    const { create, tx } = fakeTx();
    create.mockRejectedValue(new Error("tx aborted"));
    await expect(audit.writeAudit({ organizationId: "org1", action: "org.created" }, tx)).rejects.toThrow("tx aborted");
  });

  it("non-tx path: writes through the module client with the same data shape", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    await audit.writeAudit({
      organizationId: "org1",
      actorId: "u1",
      action: "member.invited",
      entityType: "OrganizationInvite",
      entityId: "inv1",
      details: { email: "a@example.com" },
      ipAddress: "203.0.113.7",
      requestId: "req-2",
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        organizationId: "org1",
        actorId: "u1",
        action: "member.invited",
        entityType: "OrganizationInvite",
        entityId: "inv1",
        details: { email: "a@example.com" },
        ipAddress: "203.0.113.7",
        requestId: "req-2",
      },
    });
  });

  it("non-tx path: a create failure is swallowed (best-effort, never a 500)", async () => {
    mocks.auditCreate.mockRejectedValue(new Error("db down"));
    await expect(audit.writeAudit({ organizationId: "org1", action: "org.created" })).resolves.toBeUndefined();
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });
});

describe("recordHealth data payloads (packages/db/src/health.ts)", () => {
  it("success: upsert update+create carry status, connection, lastSuccessAt and checkedAt", async () => {
    const result = await health.recordHealth({
      websiteId: "site-1",
      connectionId: "conn-1",
      provider: "GA4",
      status: "ok",
      success: true,
    });
    expect(result).toEqual({ id: "h-1" });
    expect(mocks.healthUpsert).toHaveBeenCalledTimes(1);
    const args = mocks.healthUpsert.mock.calls[0]![0];
    expect(args.where).toEqual({ websiteId_provider: { websiteId: "site-1", provider: "GA4" } });
    expect(args.update.connectionId).toBe("conn-1");
    expect(args.update.status).toBe("ok");
    expect(args.update.lastSuccessAt).toBeInstanceOf(Date);
    expect(args.update.lastError).toBeNull();
    expect(args.update.checkedAt).toBeInstanceOf(Date);
    expect(args.create.websiteId).toBe("site-1");
    expect(args.create.provider).toBe("GA4");
    expect(args.create.connectionId).toBe("conn-1");
    expect(args.create.status).toBe("ok");
    // The create branch reuses the same timestamps as the update branch.
    expect(args.create.lastSuccessAt).toBe(args.update.lastSuccessAt);
    expect(args.create.lastError).toBeNull();
    expect(args.create.checkedAt).toBe(args.update.checkedAt);
  });

  it("failure: no lastSuccessAt on update, null on create; lastError is secret-sanitized", async () => {
    await health.recordHealth({
      websiteId: "site-1",
      provider: "SEARCH_CONSOLE",
      status: "error",
      lastError: "provider said: invalid token ya29.a0AfH6SMBx7fK9tokenValue",
    });
    expect(mocks.healthUpsert).toHaveBeenCalledTimes(1);
    const args = mocks.healthUpsert.mock.calls[0]![0];
    expect(args.where).toEqual({ websiteId_provider: { websiteId: "site-1", provider: "SEARCH_CONSOLE" } });
    expect(args.update.connectionId).toBeNull();
    expect(args.update.status).toBe("error");
    expect(args.update.lastSuccessAt).toBeUndefined();
    expect(args.update.lastError).toContain("[REDACTED]");
    expect(args.update.lastError).not.toContain("ya29.");
    expect(args.update.checkedAt).toBeInstanceOf(Date);
    expect(args.create.connectionId).toBeNull();
    expect(args.create.lastSuccessAt).toBeNull();
    expect(args.create.lastError).toBe(args.update.lastError);
  });
});

describe("lastSuccessfulSync (packages/db/src/health.ts)", () => {
  it("queries the latest SUCCEEDED job and returns its updatedAt as ISO", async () => {
    const updatedAt = new Date("2026-11-24T10:27:00.000Z");
    mocks.syncFindFirst.mockResolvedValue({ id: "job-1", updatedAt });
    await expect(health.lastSuccessfulSync("site-1", "GA4_HISTORICAL")).resolves.toBe("2026-11-24T10:27:00.000Z");
    expect(mocks.syncFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.syncFindFirst).toHaveBeenCalledWith({
      where: { websiteId: "site-1", type: "GA4_HISTORICAL", status: "SUCCEEDED" },
      orderBy: { updatedAt: "desc" },
    });
  });

  it("returns null when no job has succeeded yet", async () => {
    await expect(health.lastSuccessfulSync("site-1", "SEARCH_CONSOLE")).resolves.toBeNull();
  });

  it("returns null when the job row has no updatedAt", async () => {
    mocks.syncFindFirst.mockResolvedValue({ id: "job-1", updatedAt: null });
    await expect(health.lastSuccessfulSync("site-1", "ADSENSE")).resolves.toBeNull();
  });
});
