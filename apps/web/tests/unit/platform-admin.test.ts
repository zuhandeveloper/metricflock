import { describe, expect, it, vi, beforeEach } from "vitest";

// Platform super admin (owner decision 2026-11-26): the FIRST registered
// user — earliest createdAt, tie-broken by id — computed dynamically by
// packages/auth/src/platform.ts. No schema flag: deleting the first user
// promotes the next-earliest.
const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@metricflock/db", () => ({
  prisma: {
    user: { findFirst: mocks.userFindFirst },
  },
}));
vi.mock("@metricflock/db/audit", () => ({ writeAudit: vi.fn() }));

import { getPlatformAdminId, isPlatformAdmin } from "@metricflock/auth";

describe("platform admin helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the earliest user's id", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u-first" });
    await expect(getPlatformAdminId()).resolves.toBe("u-first");
  });

  it("queries earliest createdAt first, tie-broken by id asc", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u-first" });
    await getPlatformAdminId();
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
  });

  it("returns null when the user table is empty", async () => {
    mocks.userFindFirst.mockResolvedValue(null);
    await expect(getPlatformAdminId()).resolves.toBeNull();
  });

  it("isPlatformAdmin is true only for the earliest user", async () => {
    mocks.userFindFirst.mockResolvedValue({ id: "u-first" });
    await expect(isPlatformAdmin("u-first")).resolves.toBe(true);
    await expect(isPlatformAdmin("u-second")).resolves.toBe(false);
  });

  it("isPlatformAdmin is false for everyone when there are no users", async () => {
    mocks.userFindFirst.mockResolvedValue(null);
    await expect(isPlatformAdmin("u-anyone")).resolves.toBe(false);
  });
});
