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
  readSnapshots: vi.fn(),
  getPrimaryIntegrations: vi.fn(),
  // Mutable report window (A-GGL-07): the default is safely in the past
  // so the SC clamp is a no-op for the other tests; the clamp test below
  // moves it to a window ending today.
  window: { startDate: "2026-10-19", endDate: "2026-11-15" },
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
// A-WRK-10: the report reads primaries + snapshots through the A-DB-11
// batch helpers, one call per page per section.
vi.mock("@metricflock/db/snapshots", () => ({ readSnapshots: mocks.readSnapshots }));
vi.mock("@metricflock/auth/mailer", () => ({
  sendMail: mocks.sendMail,
  mailerMode: mocks.mailerMode,
}));
vi.mock("@metricflock/google/client", () => ({ getPrimaryIntegrations: mocks.getPrimaryIntegrations }));
vi.mock("@metricflock/google/sync", () => ({
  last28Days: () => ({ ...mocks.window }),
}));

import { sendOrgReport } from "@metricflock/worker/report";

const RANGE = "2026-10-19_2026-11-15";
const RECIPIENTS = ["a@example.com", "b@example.com"];

function cacheKey(websiteId: string, propertyId: string, source: string, report: string) {
  return buildCacheKey({ organizationId: "org-1", websiteId, propertyId, source, report, range: RANGE });
}

describe("sendOrgReport (worker report builder)", () => {
  const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    mocks.window.startDate = "2026-10-19";
    mocks.window.endDate = "2026-11-15";
    mocks.orgFindUnique.mockResolvedValue({ id: "org-1", name: "Acme" });
    mocks.scheduleFindUnique.mockResolvedValue({ organizationId: "org-1", recipients: RECIPIENTS });
    mocks.scheduleUpdateMany.mockResolvedValue({ count: 1 });
    mocks.websiteFindMany.mockResolvedValue([]);
    mocks.healthFindMany.mockResolvedValue([]);
    mocks.integrationCount.mockResolvedValue(0);
    mocks.userFindMany.mockResolvedValue([]);
    mocks.mailerMode.mockReturnValue("smtp");
    mocks.sendMail.mockResolvedValue(undefined);
    mocks.readSnapshots.mockResolvedValue(new Map());
    mocks.getPrimaryIntegrations.mockResolvedValue(new Map());
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
    mocks.getPrimaryIntegrations.mockImplementation(async (websiteIds: string[], providers: string[]) => {
      const out = new Map<string, Map<string, { externalId: string }>>();
      for (const id of websiteIds) {
        const perSite = new Map<string, { externalId: string }>();
        for (const provider of providers) {
          if (provider === "GA4") perSite.set(provider, { externalId: id === "w1" ? "ga-1" : "ga-2" });
          if (provider === "SEARCH_CONSOLE" && id === "w1") perSite.set(provider, { externalId: "sc-1" });
          if (provider === "ADSENSE" && id === "w2") perSite.set(provider, { externalId: "ad-1" });
        }
        if (perSite.size > 0) out.set(id, perSite);
      }
      return out;
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
    mocks.readSnapshots.mockImplementation(async (keys: string[]) => {
      const out = new Map<string, unknown>();
      for (const key of keys) if (snapshots.has(key)) out.set(key, snapshots.get(key));
      return out;
    });
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
    expect(mail.subject).toBe("Acme weekly report — 2026-10-19 to 2026-11-15");
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

  it("reads the Search Console snapshot under the clamped range (A-GGL-07)", async () => {
    // Window ending today: the sync engine writes the SC snapshot under
    // the clamped key (endDate 3 days ago), the GA4 snapshot under the
    // full window. The report must find both.
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const start = fmt(new Date(today.getTime() - 27 * 86400000));
    const maxEnd = fmt(new Date(today.getTime() - 3 * 86400000));
    const end = fmt(today);
    mocks.window.startDate = start;
    mocks.window.endDate = end;
    mocks.websiteFindMany.mockResolvedValue([{ id: "w1" }]);
    mocks.getPrimaryIntegrations.mockImplementation(async (websiteIds: string[], providers: string[]) => {
      const out = new Map<string, Map<string, { externalId: string }>>();
      for (const id of websiteIds) {
        const perSite = new Map<string, { externalId: string }>();
        for (const provider of providers) {
          if (provider === "GA4") perSite.set(provider, { externalId: "ga-1" });
          if (provider === "SEARCH_CONSOLE") perSite.set(provider, { externalId: "sc-1" });
        }
        if (perSite.size > 0) out.set(id, perSite);
      }
      return out;
    });
    const key = (propertyId: string, source: string, report: string, range: string) =>
      buildCacheKey({ organizationId: "org-1", websiteId: "w1", propertyId, source, report, range });
    const snapshots = new Map<string, unknown>([
      [key("ga-1", "ga4", "overview", `${start}_${end}`), { payload: { summary: { sessions: 100 } } }],
      [
        key("sc-1", "search-console", "search-console", `${start}_${maxEnd}`),
        { payload: { totals: { clicks: 100, impressions: 5000, avgPosition: 6.5 } } },
      ],
    ]);
    mocks.readSnapshots.mockImplementation(async (keys: string[]) => {
      const out = new Map<string, unknown>();
      for (const key of keys) if (snapshots.has(key)) out.set(key, snapshots.get(key));
      return out;
    });
    const result = await sendOrgReport("org-1");
    expect(result.status).toBe("ok");
    const mail = mocks.sendMail.mock.calls[0][0] as { subject: string; text: string };
    // The email's label stays the requested window; the SC section inside
    // it comes from the clamped snapshot.
    expect(mail.subject).toBe(`Acme weekly report — ${start} to ${end}`);
    expect(mail.text).toContain("Sessions: 100");
    expect(mail.text).toContain("Clicks: 100");
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

  it("treats a throwing batch lookup or snapshot read as unavailable, not fatal", async () => {
    mocks.websiteFindMany.mockResolvedValue([{ id: "w1" }, { id: "w2" }]);
    // A-DB-11 batch equivalents of the old per-website failures: the
    // GA4 primaries batch throws, and the snapshots batch throws, so
    // every section reports its websites unavailable instead of failing
    // the whole report.
    mocks.getPrimaryIntegrations.mockImplementation(async (_websiteIds: string[], providers: string[]) => {
      if (providers.includes("GA4")) throw new Error("db blip");
      const out = new Map<string, Map<string, { externalId: string }>>();
      for (const id of _websiteIds) {
        const perSite = new Map<string, { externalId: string }>();
        if (providers.includes("SEARCH_CONSOLE") && id === "w1") perSite.set("SEARCH_CONSOLE", { externalId: "sc-1" });
        if (providers.includes("ADSENSE") && id === "w2") perSite.set("ADSENSE", { externalId: "ad-1" });
        if (perSite.size > 0) out.set(id, perSite);
      }
      return out;
    });
    mocks.readSnapshots.mockRejectedValue(new Error("snapshot store down"));
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
