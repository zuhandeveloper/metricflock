import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";
import { sendMail, mailerMode } from "@metricflock/auth/mailer";
import { buildReportEmail, type ReportSection } from "@metricflock/shared";
import { loadPortfolio, type PortfolioResult } from "@/lib/portfolio";
import { loadHealthOverview } from "@/lib/health";
import { resolveRange } from "@/lib/analytics-response";

// Send a test weekly report to the requesting SUPER_ADMIN (Phase
// 7.3). Same content the worker sends on schedule, built from the
// same snapshots; only the recipient differs (you, not the list).
function toSection(r: PortfolioResult): ReportSection {
  return {
    totals: r.websites.length ? r.totals : null,
    note: r.totalsNote,
    websiteCount: r.websites.length,
    unavailableCount: r.unavailableWebsites.length,
  };
}

async function post(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage", { req, rateLimit: "strict" });
  if ("error" in auth) return auth.error;
  const org = await prisma.organization.findUnique({
    where: { id: auth.user.organizationId },
    select: { name: true },
  });
  const { startDate, endDate } = resolveRange("28d");
  const base = { startDate, endDate };
  const [ga4, searchConsole, adsense, health] = await Promise.all([
    loadPortfolio(auth.user, { ...base, provider: "GA4", source: "ga4", report: "overview" }),
    loadPortfolio(auth.user, {
      ...base,
      provider: "SEARCH_CONSOLE",
      source: "search-console",
      report: "search-console",
    }),
    loadPortfolio(auth.user, { ...base, provider: "ADSENSE", source: "adsense", report: "adsense" }),
    loadHealthOverview(auth.user, 1),
  ]);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const { subject, text } = buildReportEmail({
    orgName: org?.name ?? "MetricFlock",
    rangeLabel: `${startDate} to ${endDate}`,
    ga4: toSection(ga4),
    searchConsole: toSection(searchConsole),
    adsense: toSection(adsense),
    health: health.summary,
    appUrl,
  });
  let delivered = false;
  try {
    await sendMail({ to: auth.user.email, subject: `[Test] ${subject}`, text });
    delivered = mailerMode() === "smtp";
  } catch {
    delivered = false;
  }
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    action: "report.test_sent",
    entityType: "Organization",
    entityId: auth.user.organizationId,
    details: { delivered },
  }).catch(() => undefined); // A-API-04: audit failure must not turn a sent test report into a 500.
  return NextResponse.json({ ok: delivered, to: auth.user.email });
}

export const POST = withApiErrors("reports/send-test", post);
