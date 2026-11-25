import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  healthUpsert: vi.fn(),
  healthCreate: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    integrationHealth: { upsert: mocks.healthUpsert, create: mocks.healthCreate },
  },
}));

import { recordHealth } from "@metricflock/db/health";

// A-DB-13: recordHealth used to append a new IntegrationHealth row on
// every connection-level call (no websiteId) because the
// @@unique([websiteId, provider]) cannot match NULLs — and no consumer
// can read those rows back (the alerting wrapper, the report and the
// health dashboard all scope by website). Connection-level calls now
// write nothing instead of accumulating unreadable rows; the
// scheduler tick prunes any pre-existing NULL-website rows.
describe("recordHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.healthUpsert.mockResolvedValue({ id: "h-1" });
    mocks.healthCreate.mockResolvedValue({ id: "h-1" });
  });

  it("upserts on (websiteId, provider) when a websiteId is given", async () => {
    await recordHealth({ websiteId: "site-1", connectionId: "conn-1", provider: "GA4", status: "ok", success: true });

    expect(mocks.healthUpsert).toHaveBeenCalledTimes(1);
    const args = mocks.healthUpsert.mock.calls[0][0] as Record<string, unknown>;
    expect(args.where).toEqual({ websiteId_provider: { websiteId: "site-1", provider: "GA4" } });
    expect(mocks.healthCreate).not.toHaveBeenCalled();
  });

  it("writes nothing when websiteId is absent, even with a connectionId (A-DB-13)", async () => {
    const result = await recordHealth({ connectionId: "conn-1", provider: "GA4", status: "error", lastError: "boom" });

    expect(result).toBeNull();
    expect(mocks.healthUpsert).not.toHaveBeenCalled();
    expect(mocks.healthCreate).not.toHaveBeenCalled();
  });

  it("writes nothing when neither websiteId nor connectionId is given (A-DB-13)", async () => {
    const result = await recordHealth({ provider: "ADSENSE", status: "error" });

    expect(result).toBeNull();
    expect(mocks.healthUpsert).not.toHaveBeenCalled();
    expect(mocks.healthCreate).not.toHaveBeenCalled();
  });
});
