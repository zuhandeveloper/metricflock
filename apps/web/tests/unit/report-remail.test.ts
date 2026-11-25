import { describe, it, expect, beforeEach, vi } from "vitest";

// A-WRK-03: the weekly-report send loop must be per-recipient
// fault-isolated. If SMTP fails on recipient 2 of 3, recipient 1 must
// not be mailed twice: the send returns `ok` with the failure named
// (so BullMQ schedules no retry) and lastSentAt is still recorded (so
// the next tick does not re-mail recipients who already got it). Only
// when ZERO recipients were mailed does the job throw — and then a
// retry cannot duplicate anything, because nobody received a copy.
const mocks = vi.hoisted(() => ({
  orgFindUnique: vi.fn(),
  scheduleFindUnique: vi.fn(),
  scheduleUpdateMany: vi.fn(),
  websiteFindMany: vi.fn(),
  healthFindMany: vi.fn(),
  integrationCount: vi.fn(),
  userFindMany: vi.fn(),
  sendMail: vi.fn(),
  mailerMode: vi.fn(),
}));

vi.mock("@metricflock/db", () => ({
  prisma: {
    organization: { findUnique: mocks.orgFindUnique },
    reportSchedule: { findUnique: mocks.scheduleFindUnique, updateMany: mocks.scheduleUpdateMany },
    website: { findMany: mocks.websiteFindMany },
    integrationHealth: { findMany: mocks.healthFindMany },
    websiteIntegration: { count: mocks.integrationCount },
    user: { findMany: mocks.userFindMany },
  },
}));
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshots: vi.fn(async () => new Map()) }));
vi.mock("@metricflock/auth/mailer", () => ({
  sendMail: mocks.sendMail,
  mailerMode: mocks.mailerMode,
}));
// A-WRK-10: the report reads primaries + snapshots through the A-DB-11
// batch helpers; this file's fixtures have no websites, so they are
// never called — but the module must export them.
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegrations: vi.fn(async () => new Map()) }));
vi.mock("@metricflock/google/sync", () => ({
  last28Days: () => ({ startDate: "2026-10-19", endDate: "2026-11-15" }),
}));

import { sendOrgReport } from "@metricflock/worker/report";

const RECIPIENTS = ["a@example.com", "b@example.com", "c@example.com"];

describe("sendOrgReport per-recipient isolation (A-WRK-03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgFindUnique.mockResolvedValue({ id: "org-1", name: "Acme" });
    mocks.scheduleFindUnique.mockResolvedValue({ organizationId: "org-1", recipients: RECIPIENTS });
    mocks.scheduleUpdateMany.mockResolvedValue({ count: 1 });
    mocks.websiteFindMany.mockResolvedValue([]);
    mocks.healthFindMany.mockResolvedValue([]);
    mocks.integrationCount.mockResolvedValue(0);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.mailerMode.mockReturnValue("smtp");
    mocks.sendMail.mockResolvedValue(undefined);
  });

  const callsFor = (to: string) => mocks.sendMail.mock.calls.filter((c) => (c[0] as { to: string }).to === to).length;

  it("SMTP failure on recipient 2 of 3: recipient 1 is mailed once, job succeeds, lastSentAt is set", async () => {
    mocks.sendMail.mockImplementation(async ({ to }: { to: string }) => {
      if (to === "b@example.com") throw new Error("SMTP 550 mailbox unavailable");
    });
    const result = await sendOrgReport("org-1");
    // No throw → BullMQ schedules no retry → no second copy to anyone.
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("2/3");
    expect(result.detail).toContain("b@example.com");
    expect(mocks.sendMail).toHaveBeenCalledTimes(3);
    expect(callsFor("a@example.com")).toBe(1);
    expect(callsFor("c@example.com")).toBe(1);
    // Partial success still records the send, so the next scheduled tick
    // does not re-mail the recipients who already got this report.
    expect(mocks.scheduleUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleUpdateMany.mock.calls[0][0].data.lastSentAt).toBeInstanceOf(Date);
  });

  it("all recipients failing throws (retry is safe: nobody received a copy) and lastSentAt is untouched", async () => {
    mocks.sendMail.mockRejectedValue(new Error("SMTP connection refused"));
    await expect(sendOrgReport("org-1")).rejects.toThrow("weekly report delivery failed for all 3");
    expect(mocks.sendMail).toHaveBeenCalledTimes(3);
    expect(mocks.scheduleUpdateMany).not.toHaveBeenCalled();
  });
});
