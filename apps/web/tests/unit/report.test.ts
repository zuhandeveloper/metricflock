import { describe, expect, it } from "vitest";
import { buildReportEmail, isReportDue, type ReportSection } from "@metricflock/shared";

const section = (totals: Record<string, number | null> | null): ReportSection => ({
  totals,
  note: null,
  websiteCount: totals ? 2 : 0,
  unavailableCount: 1,
});

describe("buildReportEmail (Phase 7.3)", () => {
  it("formats portfolio totals and health, and is honest about missing data", () => {
    const { subject, text } = buildReportEmail({
      orgName: "Acme",
      rangeLabel: "2026-10-26 to 2026-11-22",
      ga4: section({ sessions: 1234, activeUsers: 900, screenPageViews: 3000, engagementRate: 0.5, keyEvents: 12 }),
      searchConsole: section({ clicks: 100, impressions: 5000, avgCtr: 0.02, avgPosition: 6.62 }),
      adsense: section(null),
      health: { healthy: 3, error: 1, stale: 0, withoutRecord: 2 },
      appUrl: "https://metricflock.bond",
    });
    expect(subject).toContain("Acme weekly report");
    expect(text).toContain("Sessions: 1,234");
    expect(text).toContain("Engagement rate: 50.0%");
    expect(text).toContain("Average position: 6.6");
    expect(text).toContain("No data yet"); // AdSense section has no totals
    expect(text).toContain("3 healthy, 1 error, 0 stale, 2 without a health record yet");
    expect(text).toContain("https://metricflock.bond/dashboard");
  });
});

describe("isReportDue (Phase 7.3)", () => {
  const monday8 = new Date(Date.UTC(2026, 10, 23, 8, 30)); // 2026-11-23 is a Monday
  const base = { enabled: true, dayOfWeek: 1, hourUtc: 8, lastSentAt: null };

  it("is due on the configured weekday/hour when never sent", () => {
    expect(isReportDue(base, monday8)).toBe(true);
  });
  it("is not due when disabled, wrong day, or wrong hour", () => {
    expect(isReportDue({ ...base, enabled: false }, monday8)).toBe(false);
    expect(isReportDue({ ...base, dayOfWeek: 2 }, monday8)).toBe(false);
    expect(isReportDue({ ...base, hourUtc: 9 }, monday8)).toBe(false);
  });
  it("is not due again within 6 days of the last send", () => {
    expect(isReportDue({ ...base, lastSentAt: new Date(Date.UTC(2026, 10, 23, 8, 5)) }, monday8)).toBe(false);
    expect(isReportDue({ ...base, lastSentAt: new Date(Date.UTC(2026, 10, 16, 8, 5)) }, monday8)).toBe(true);
  });
});
