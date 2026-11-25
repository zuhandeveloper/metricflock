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

const SIX_DAYS_MS = 6 * 86_400_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;

export type ReportDueKind = "window" | "catch-up";

/** Why a weekly report is due right now (UTC), or null when it is not
 * due. "window": the configured weekday/hour matches and the last send
 * was at least 6 days ago (guards against double-sends inside the
 * hour). "catch-up" (A-WRK-06): the last send was at least 7 days ago,
 * regardless of the configured hour — a full weekly cycle passed with
 * no send (worker down, Redis down, lock held, tick overran the hour),
 * so the report goes out on the next tick instead of waiting for the
 * same weekday/hour next week. A schedule that was never sent is NOT
 * a catch-up: it waits for its first window instead of firing within
 * a minute of being created. When both apply (stale send, and right
 * now is the configured window) the window wins, so an on-time send
 * is never counted as a missed one. */
export function getReportDueKind(
  schedule: { enabled: boolean; dayOfWeek: number; hourUtc: number; lastSentAt: Date | null },
  now: Date,
): ReportDueKind | null {
  if (!schedule.enabled) return null;
  const sinceLast = schedule.lastSentAt ? now.getTime() - schedule.lastSentAt.getTime() : Number.POSITIVE_INFINITY;
  if (now.getUTCDay() === schedule.dayOfWeek && now.getUTCHours() === schedule.hourUtc && sinceLast >= SIX_DAYS_MS) {
    return "window";
  }
  if (schedule.lastSentAt && sinceLast >= SEVEN_DAYS_MS) return "catch-up";
  return null;
}

/** Is a weekly report due right now (UTC)? Due when enabled, the
 * weekday and hour match, and the last send was not within the past
 * 6 days (guards against double-sends inside the same hour) — or when
 * the last send is over 7 days old, as a catch-up (A-WRK-06). */
export function isReportDue(
  schedule: { enabled: boolean; dayOfWeek: number; hourUtc: number; lastSentAt: Date | null },
  now: Date,
): boolean {
  return getReportDueKind(schedule, now) !== null;
}
