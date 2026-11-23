// Scheduled report email content (Phase 7.3). Pure: the caller loads
// portfolio totals + health summary; this formats the plain-text
// email. Numbers come from DB snapshots — when a section has no data
// the email says so instead of printing zeros.

export type ReportSection = {
  totals: Record<string, number | null> | null;
  note: string | null;
  websiteCount: number;
  unavailableCount: number;
};

export type ReportInput = {
  orgName: string;
  rangeLabel: string;
  ga4: ReportSection;
  searchConsole: ReportSection;
  adsense: ReportSection;
  health: { healthy: number; error: number; stale: number; withoutRecord: number };
  appUrl: string;
};

const fmt = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined
    ? "—"
    : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;

function section(title: string, s: ReportSection, lines: string[]): string {
  const head = `${title} (${s.websiteCount} website${s.websiteCount === 1 ? "" : "s"} with data${
    s.unavailableCount > 0 ? `, ${s.unavailableCount} without a snapshot yet` : ""
  })`;
  if (!s.totals) return `${head}\n  No data yet — syncs have not produced snapshots for this range.`;
  return `${head}\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

export function buildReportEmail(input: ReportInput): { subject: string; text: string } {
  const { ga4, searchConsole: sc, adsense, health } = input;
  const g = ga4.totals ?? {};
  const s = sc.totals ?? {};
  const a = adsense.totals ?? {};
  const body = [
    `${input.orgName} — weekly portfolio report (${input.rangeLabel})`,
    "",
    section("Google Analytics 4", ga4, [
      `Sessions: ${fmt(g.sessions)}`,
      `Active users: ${fmt(g.activeUsers)} (sum across properties)`,
      `Page views: ${fmt(g.screenPageViews)}`,
      `Engagement rate: ${pct(g.engagementRate)}`,
      `Key events: ${fmt(g.keyEvents)}`,
    ]),
    "",
    section("Search Console", sc, [
      `Clicks: ${fmt(s.clicks)}`,
      `Impressions: ${fmt(s.impressions)}`,
      `Average CTR: ${pct(s.avgCtr)}`,
      `Average position: ${fmt(s.avgPosition, 1)}`,
    ]),
    "",
    section("AdSense (estimated earnings)", adsense, [
      `Estimated earnings: ${fmt(a.ESTIMATED_EARNINGS, 2)}`,
      `Page views: ${fmt(a.PAGE_VIEWS)}`,
      `Clicks: ${fmt(a.CLICKS)}`,
      `Page RPM: ${fmt(a.PAGE_RPM, 2)}`,
    ]),
    "",
    `Integration health: ${health.healthy} healthy, ${health.error} error, ${health.stale} stale, ${health.withoutRecord} without a health record yet.`,
    "",
    `Details: ${input.appUrl}/dashboard`,
    "Figures come from the latest synced snapshots; AdSense earnings are estimates, not finalized payments.",
  ].join("\n");
  return { subject: `${input.orgName} weekly report — ${input.rangeLabel}`, text: body };
}

/** Is a weekly report due right now (UTC)? Due when enabled, the
 * weekday and hour match, and the last send was not within the past
 * 6 days (guards against double-sends inside the same hour). */
export function isReportDue(
  schedule: { enabled: boolean; dayOfWeek: number; hourUtc: number; lastSentAt: Date | null },
  now: Date,
): boolean {
  if (!schedule.enabled) return false;
  if (now.getUTCDay() !== schedule.dayOfWeek) return false;
  if (now.getUTCHours() !== schedule.hourUtc) return false;
  if (schedule.lastSentAt && now.getTime() - schedule.lastSentAt.getTime() < 6 * 86_400_000) return false;
  return true;
}
