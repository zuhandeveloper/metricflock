import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import path from "path";

// A-DB-09: writeAudit takes an optional transaction client, and without
// one it is best-effort (failure logged, never thrown). The module
// imports the client as "./client", so — like db-snapshots-seed.test.ts —
// the mock is registered with vi.doMock on the computed absolute path
// (not hoisted) and the module is imported dynamically after it.
// Mocking "@metricflock/db" would miss, because audit.ts never imports
// that specifier.
const CLIENT_PATH = path.resolve(process.cwd(), "../../packages/db/src/client.ts");
const rootAuditCreate = vi.fn();
const txAuditCreate = vi.fn();

function registerClientMock() {
  vi.doMock(CLIENT_PATH, () => ({
    prisma: { auditLog: { create: rootAuditCreate } },
  }));
}

type AuditModule = typeof import("@metricflock/db/audit");
let audit: AuditModule;

async function loadAudit(): Promise<AuditModule> {
  registerClientMock();
  vi.resetModules();
  audit = await import("@metricflock/db/audit");
  return audit;
}

const opts = {
  organizationId: "org1",
  actorId: "u1",
  action: "member.deleted",
  entityType: "User",
  entityId: "u2",
  details: { email: "m@example.com" },
};

describe("writeAudit (A-DB-09)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    await loadAudit();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    rootAuditCreate.mockResolvedValue({ id: "a1" });
    txAuditCreate.mockResolvedValue({ id: "a1" });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("best-effort: writes the row through the root client", async () => {
    await audit.writeAudit(opts);
    expect(rootAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "member.deleted", entityType: "User", entityId: "u2" }),
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("best-effort: a failing create resolves anyway and logs the failure", async () => {
    rootAuditCreate.mockRejectedValue(new Error("audit down"));
    await expect(audit.writeAudit(opts)).resolves.toBeUndefined();
    const logged = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(logged).toContain("audit.write_failed");
    expect(logged).toContain("member.deleted");
  });

  it("with a transaction client: writes through the transaction, not the root client", async () => {
    const tx = { auditLog: { create: txAuditCreate } } as unknown as Parameters<typeof audit.writeAudit>[1];
    await audit.writeAudit(opts, tx);
    expect(txAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "member.deleted" }),
    });
    expect(rootAuditCreate).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("with a transaction client: a failing create propagates (the caller rolls back)", async () => {
    const tx = { auditLog: { create: txAuditCreate } } as unknown as Parameters<typeof audit.writeAudit>[1];
    txAuditCreate.mockRejectedValue(new Error("audit down"));
    await expect(audit.writeAudit(opts, tx)).rejects.toThrow("audit down");
    expect(rootAuditCreate).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });
});
