import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildCacheKey } from "@metricflock/shared";

// sendOrgReport (apps/worker/src/report.ts): the parts the A-WRK-03
// remail tests do not cover — org/schedule/recipient resolution,
// snapshot aggregation across websites, health summary, and the
// SMTP-not-configured guard. The per-recipient fault-isolation cases
// live in report-remail.test.ts and are not duplicated here.
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
  readSnapshot: vi.fn(),
  getPrimaryIntegration: vi.fn(),
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
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshot: mocks.readSnapshot }));
vi.mock("@metricflock/auth/mailer", () => ({
  sendMail: mocks.sendMail,
  mailerMode: mocks.mailerMode,
}));
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegration: mocks.getPrimaryIntegration }));
vi.mock("@metricflock/google/sync", () => ({
  last28Days: () => ({ startDate: "2026-10-26", endDate: "2026-11-22" }),
}));

import { sendOrgReport } from "@metricflock/worker/report";

const RANGE = "2026-10-26_2026-11-22";
const RECIPIENTS = ["a@example.com", "b@example.com"];

function cacheKey(websiteId: string, propertyId: string, source: string, report: string) {
  return buildCacheKey({ organizationId: "org-1", websiteId, propertyId, source, report, range: RANGE });
}

describe("sendOrgReport (worker report builder)", () => {
  const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.orgFindUnique.mockResolvedValue({ id: "org-1", name: "Acme" });
    mocks.scheduleFindUnique.mockResolvedValue({ organizationId: "org-1", recipients: RECIPIENTS });
    mocks.scheduleUpdateMany.mockResolvedValue({ count: 1 });
    mocks.websiteFindMany.mockResolvedValue([]);
    mocks.healthFindMany.mockResolvedValue([]);
    mocks.integrationCount.mockResolvedValue(0);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.mailerMode.mockReturnValue("smtp");
    mocks.sendMail.mockResolvedValue(undefined);
    mocks.readSnapshot.mockResolvedValue(null);
    mocks.getPrimaryIntegration.mockResolvedValue(null);
  });

  afterEach(() => {
    if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
  });

  it("returns skipped when the organization does not exist", async () => {
    mocks.orgFindUnique.mockResolvedValue(null);
    const result = await sendOrgReport("org-missing");
    expect(result).toEqual({ status: "skipped", reports: [], detail: "organization not found" });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateMany).not.toHaveBeenCalled();
  });

  it("aggregates snapshots across websites, summarizes health, and mails the configured recipients", async () => {
    const now = new Date();
    mocks.websiteFindMany.mockResolvedValue([{ id: "w1" }, { id: "w2" }]);
    mocks.getPrimaryIntegration.mockImplementation(async (websiteId: string, provider: string) => {
      if (provider === "GA4") return { externalId: websiteId === "w1" ? "ga-1" : "ga-2" };
      if (provider === "SEARCH_CONSOLE") return websiteId === "w1" ? { externalId: "sc-1" } : null;
      return websiteId === "w2" ? { externalId: "ad-1" } : null; // ADSENSE
    });
    const snapshots = new Map<string, unknown>([
      [
        cacheKey("w1", "ga-1", "ga4", "overview"),
        {
          payload: {
            summary: { sessions: 1000, activeUsers: 800, screenPageViews: 2500, engagedSessions: 500, keyEvents: 10 },
          },
        },
      ],
      [
        cacheKey("w2", "ga-2", "ga4", "overview"),
        {
          payload: {
            summary: { sessions: 2000, activeUsers: 1500, screenPageViews: 4000, engagedSessions: 1200, keyEvents: 25 },
          },
        },
      ],
      [
        cacheKey("w1", "sc-1", "search-console", "search-console"),
        { payload: { totals: { clicks: 100, impressions: 5000, avgPosition: 6.5 } } },
      ],
      // w2 AdSense has an integration but no snapshot: unavailable.
    ]);
    mocks.readSnapshot.mockImplementation(async (key: string) => snapshots.get(key) ?? null);
    mocks.healthFindMany.mockResolvedValue([
      { status: "ok", lastSuccessAt: now },
      { status: "error", lastSuccessAt: null },
      { status: "ok", lastSuccessAt: new Date(now.getTime() - 3 * 86_400_000) },
    ]);
    mocks.integrationCount.mockResolvedValue(5);

    const result = await sendOrgReport("org-1");

    expect(result.status).toBe("ok");
    expect(result.detail).toBe("report sent to 2/2 recipients");
    expect(mocks.sendMail).toHaveBeenCalledTimes(2);
    const mail = mocks.sendMail.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(mail.to).toBe("a@example.com");
    expect(mail.subject).toBe("Acme weekly report — 2026-10-26 to 2026-11-22");
    expect(mail.text).toContain("Sessions: 3,000"); // 1000 + 2000 summed across websites
    expect(mail.text).toContain("Active users: 2,300");
    expect(mail.text).toContain("Clicks: 100");
    expect(mail.text).toContain("No data yet"); // AdSense has no snapshots at all
    expect(mail.text).toContain("1 healthy, 1 error, 1 stale, 2 without a health record yet");
    expect(mail.text).toContain("https://app.example.com/dashboard");
    expect(mocks.scheduleUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
      data: { lastSentAt: expect.any(Date) },
    });
  });

  it("falls back to org SUPER_ADMINs when no schedule exists", async () => {
    mocks.scheduleFindUnique.mockResolvedValue(null);
    mocks.userFindMany.mockResolvedValue([{ email: "admin@example.com" }]);
    const result = await sendOrgReport("org-1");
    expect(result.status).toBe("ok");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect((mocks.sendMail.mock.calls[0][0] as { to: string }).to).toBe("admin@example.com");
  });

  it("filters invalid configured recipients and keeps only real email addresses", async () => {
    mocks.scheduleFindUnique.mockResolvedValue({
      organizationId: "org-1",
      recipients: ["good@example.com", "no-at-sign", 42, "", null],
    });
    const result = await sendOrgReport("org-1");
    expect(result.status).toBe("ok");
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect((mocks.sendMail.mock.calls[0][0] as { to: string }).to).toBe("good@example.com");
    // The invalid entries did not trigger a SUPER_ADMIN fallback lookup.
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it("returns skipped with no recipients when neither schedule nor admins exist", async () => {
    mocks.scheduleFindUnique.mockResolvedValue(null);
    mocks.userFindMany.mockResolvedValue([]);
    const result = await sendOrgReport("org-1");
    expect(result).toEqual({ status: "skipped", reports: [], detail: "no recipients" });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateMany).not.toHaveBeenCalled();
  });

  it("returns skipped without recording a send when SMTP is not configured", async () => {
    mocks.mailerMode.mockReturnValue("log");
    const result = await sendOrgReport("org-1");
    expect(result).toEqual({ status: "skipped", reports: [], detail: "SMTP not configured; report not sent" });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateMany).not.toHaveBeenCalled();
  });

  it("records a non-Error throw from sendMail as its string form", async () => {
    mocks.sendMail.mockImplementation(async ({ to }: { to: string }) => {
      if (to === "b@example.com") throw "SMTP string failure";
    });
    const result = await sendOrgReport("org-1");
    expect(result.status).toBe("ok");
    expect(result.detail).toBe("report sent to 1/2 recipients; failed: b@example.com");
    expect(mocks.scheduleUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("treats a throwing integration lookup or snapshot read as unavailable, not fatal", async () => {
    mocks.websiteFindMany.mockResolvedValue([{ id: "w1" }, { id: "w2" }]);
    mocks.getPrimaryIntegration.mockImplementation(async (websiteId: string, provider: string) => {
      if (websiteId === "w1" && provider === "GA4") throw new Error("db blip");
      if (provider === "GA4") return { externalId: "ga-2" };
      return null;
    });
    mocks.readSnapshot.mockImplementation(async (key: string) => {
      if (key.includes("ga-2")) throw new Error("snapshot store down");
      return null;
    });
    const result = await sendOrgReport("org-1");
    expect(result.status).toBe("ok");
    const mail = mocks.sendMail.mock.calls[0][0] as { text: string };
    expect(mail.text).toContain("No data yet"); // both GA4 payloads unavailable
    expect(mail.text).toContain("2 without a snapshot yet");
  });

  it("defaults the dashboard link to localhost when NEXT_PUBLIC_APP_URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const result = await sendOrgReport("org-1");
    expect(result.status).toBe("ok");
    const mail = mocks.sendMail.mock.calls[0][0] as { text: string };
    expect(mail.text).toContain("http://localhost:3000/dashboard");
  });
});
