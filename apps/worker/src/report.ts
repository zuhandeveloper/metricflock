// Weekly portfolio report sender (Phase 7.3). Builds the report from
// per-website DB snapshots (the same 28-day window the sync engine
// writes) — never live Google fan-out — and emails it to the
// schedule's recipients (or the org's SUPER_ADMINs when none are
// configured).
import { prisma } from "@metricflock/db";
import { readSnapshot } from "@metricflock/db/snapshots";
import { sendMail, mailerMode } from "@metricflock/auth/mailer";
import { getPrimaryIntegration } from "@metricflock/google/client";
import { last28Days } from "@metricflock/google/sync";
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

  const websites = await prisma.website.findMany({
    where: { organizationId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const range = last28Days(new Date());

  const sections: Record<string, ReportSection> = {};
  for (const cfg of REPORTS) {
    const payloads: unknown[] = [];
    let unavailable = 0;
    await Promise.all(
      websites.map(async (w) => {
        const integration = await getPrimaryIntegration(w.id, cfg.provider).catch(() => null);
        if (!integration) {
          unavailable += 1;
          return;
        }
        const cacheKey = buildCacheKey({
          organizationId,
          websiteId: w.id,
          propertyId: integration.externalId,
          source: cfg.source,
          report: cfg.report,
          range: `${range.startDate}_${range.endDate}`,
        });
        const snapshot = await readSnapshot(cacheKey).catch(() => null);
        if (!snapshot) {
          unavailable += 1;
          return;
        }
        payloads.push(snapshot.payload);
      }),
    );
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
