// Weekly portfolio report sender (Phase 7.3). Builds the report from
// per-website DB snapshots (the same 28-day window the sync engine
// writes) — never live Google fan-out — and emails it to the
// schedule's recipients (or the org's SUPER_ADMINs when none are
// configured).
import { prisma } from "@metricflock/db";
import { readSnapshots } from "@metricflock/db/snapshots";
import { sendMail, mailerMode } from "@metricflock/auth/mailer";
import { getPrimaryIntegrations } from "@metricflock/google/client";
import { last28Days } from "@metricflock/google/sync";
import { clampSearchConsoleRange } from "@metricflock/google/search-console";
import {
  aggregatePayloads,
  buildCacheKey,
  buildReportEmail,
  createLogger,
  deriveHealthState,
  type ReportSection,
} from "@metricflock/shared";
import type { SyncResult } from "@metricflock/google/sync";

const log = createLogger("report");

const REPORTS = [
  { key: "ga4", provider: "GA4", source: "ga4", report: "overview" },
  { key: "searchConsole", provider: "SEARCH_CONSOLE", source: "search-console", report: "search-console" },
  { key: "adsense", provider: "ADSENSE", source: "adsense", report: "adsense" },
] as const;

export async function sendOrgReport(organizationId: string): Promise<SyncResult> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true },
  });
  if (!org) return { status: "skipped", reports: [], detail: "organization not found" };
  const schedule = await prisma.reportSchedule.findUnique({ where: { organizationId } });

  const range = last28Days(new Date());
  // A-GGL-07: the Search Console snapshots the sync engine writes live
  // under the clamped range (endDate 3 days ago), so the report's SC
  // section must read that key — otherwise every website would show
  // unavailable for Search Console. GA4/AdSense keep the 28d window.
  // The email's rangeLabel stays the requested 28d window: it covers
  // three providers, and only the SC slice inside it is clamped.
  const scRange = clampSearchConsoleRange(range.startDate, range.endDate);

  // A-WRK-10: the website load is paginated instead of capped at 200 —
  // an org with 500 sites used to get a report that silently omitted
  // 300 of them, with totals that looked complete. Pages are processed
  // one at a time (bounded memory per page) and the A-DB-11 batch
  // helpers keep each page to one primaries + one snapshots query per
  // section, instead of the old 2N per-website round-trips. A failed
  // batch degrades the way a failed per-website lookup used to: the
  // affected websites are reported unavailable, never fatal.
  const PAGE_SIZE = 200;
  const accumulators: Record<string, { payloads: unknown[]; unavailable: number }> = {
    ga4: { payloads: [], unavailable: 0 },
    searchConsole: { payloads: [], unavailable: 0 },
    adsense: { payloads: [], unavailable: 0 },
  };
  let skip = 0;
  for (;;) {
    const page = await prisma.website.findMany({
      where: { organizationId },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      skip,
      take: PAGE_SIZE,
    });
    if (page.length === 0) break;
    skip += page.length;
    const pageIds = page.map((w) => w.id);
    for (const cfg of REPORTS) {
      const acc = accumulators[cfg.key]!;
      const cfgRange = cfg.provider === "SEARCH_CONSOLE" ? scRange : range;
      let primaries: Awaited<ReturnType<typeof getPrimaryIntegrations>>;
      try {
        primaries = await getPrimaryIntegrations(pageIds, [cfg.provider]);
      } catch {
        primaries = new Map();
      }
      const cacheKeys = new Map<string, string>();
      for (const w of page) {
        const integration = primaries.get(w.id)?.get(cfg.provider);
        if (!integration) {
          acc.unavailable += 1;
          continue;
        }
        cacheKeys.set(
          w.id,
          buildCacheKey({
            organizationId,
            websiteId: w.id,
            propertyId: integration.externalId,
            source: cfg.source,
            report: cfg.report,
            range: `${cfgRange.startDate}_${cfgRange.endDate}`,
          }),
        );
      }
      let snapshots: Awaited<ReturnType<typeof readSnapshots>>;
      try {
        snapshots = await readSnapshots([...cacheKeys.values()]);
      } catch {
        snapshots = new Map();
      }
      for (const w of page) {
        const key = cacheKeys.get(w.id);
        if (!key) continue;
        const snapshot = snapshots.get(key);
        if (!snapshot) {
          acc.unavailable += 1;
          continue;
        }
        acc.payloads.push(snapshot.payload);
      }
    }
    if (page.length < PAGE_SIZE) break;
  }

  const sections: Record<string, ReportSection> = {};
  for (const cfg of REPORTS) {
    const { payloads, unavailable } = accumulators[cfg.key]!;
    const { totals, note } = aggregatePayloads(cfg.report, payloads);
    sections[cfg.key] = {
      totals: payloads.length ? totals : null,
      note,
      websiteCount: payloads.length,
      unavailableCount: unavailable,
    };
  }

  const now = new Date();
  const healthRows = await prisma.integrationHealth.findMany({
    where: { website: { organizationId } },
    select: { status: true, lastSuccessAt: true },
  });
  const health = { healthy: 0, error: 0, stale: 0, withoutRecord: 0 };
  for (const row of healthRows) health[deriveHealthState(row, now)] += 1;
  const mapped = await prisma.websiteIntegration.count({
    where: { website: { organizationId }, mappingStatus: "MAPPED" },
  });
  health.withoutRecord = Math.max(0, mapped - healthRows.length);

  const configured = Array.isArray(schedule?.recipients)
    ? (schedule.recipients as unknown[]).filter((r): r is string => typeof r === "string" && r.includes("@"))
    : [];
  const recipients =
    configured.length > 0
      ? configured
      : (
          await prisma.user.findMany({
            where: { organizationId, role: "SUPER_ADMIN" },
            select: { email: true },
          })
        ).map((u) => u.email);
  if (recipients.length === 0) return { status: "skipped", reports: [], detail: "no recipients" };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const { subject, text } = buildReportEmail({
    orgName: org.name,
    rangeLabel: `${range.startDate} to ${range.endDate}`,
    ga4: sections.ga4!,
    searchConsole: sections.searchConsole!,
    adsense: sections.adsense!,
    health,
    appUrl,
  });
  if (mailerMode() !== "smtp") {
    // Nothing was delivered; do not record lastSentAt or the next
    // week's run would be suppressed by a send that never happened.
    log.error("weekly report not sent — SMTP not configured", { organizationId });
    return { status: "skipped", reports: [], detail: "SMTP not configured; report not sent" };
  }
  // A-WRK-03: per-recipient fault isolation. The old loop threw on the
  // first failed recipient, so `lastSentAt` was never written, the BullMQ
  // job retried, and every retry re-mailed the recipients who had already
  // received the report (up to 5 copies). Now each send is tried
  // independently and failures are collected, never thrown mid-loop.
  //
  // Idempotent re-send without a schema change: ReportSchedule has no
  // per-recipient sent column (and this row adds no migration), so the
  // duplicate-mail guarantee comes from the outcome rule instead — the
  // job only throws (and therefore only retries) when ZERO recipients
  // were mailed, in which case a retry cannot duplicate anything. A
  // partial success returns `ok` with the failed recipients named in
  // `detail`, and `lastSentAt` is still recorded so the next tick does
  // not re-mail the recipients who already got it.
  const sent: string[] = [];
  const failed: { to: string; error: string }[] = [];
  for (const to of recipients) {
    try {
      await sendMail({ to, subject, text });
      sent.push(to);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failed.push({ to, error: message });
      log.error("weekly report failed for recipient", { organizationId, to, error: message });
    }
  }
  if (sent.length === 0) {
    // Nobody received anything: safe to throw so BullMQ retries. The
    // retry re-attempts the same set, still with zero prior deliveries.
    throw new Error(
      `weekly report delivery failed for all ${recipients.length} recipient(s): ${failed
        .map((f) => `${f.to} (${f.error})`)
        .join("; ")}`,
    );
  }
  await prisma.reportSchedule.updateMany({
    where: { organizationId },
    data: { lastSentAt: new Date() },
  });
  log.info("weekly report sent", {
    organizationId,
    recipients: recipients.length,
    sent: sent.length,
    failed: failed.map((f) => f.to),
  });
  return {
    status: "ok",
    reports: [],
    detail:
      failed.length === 0
        ? `report sent to ${sent.length}/${recipients.length} recipients`
        : `report sent to ${sent.length}/${recipients.length} recipients; failed: ${failed.map((f) => f.to).join(", ")}`,
  };
}
