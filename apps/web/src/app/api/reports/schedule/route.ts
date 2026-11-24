import { NextRequest, NextResponse } from "next/server";
import { withApiErrors, apiError } from "@/lib/api-error";
import { requireApiAuth } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { writeAudit } from "@metricflock/db/audit";

// Weekly report schedule (Phase 7.3). SUPER_ADMIN only
// (organization.manage). One schedule per organization; the worker's
// scheduler sends the report on the configured weekday/hour (UTC)
// to the configured recipients (or SUPER_ADMINs when empty).

const DEFAULTS = { enabled: false, dayOfWeek: 1, hourUtc: 8, recipients: [] as string[], lastSentAt: null };

function shape(s: {
  enabled: boolean;
  dayOfWeek: number;
  hourUtc: number;
  recipients: unknown;
  lastSentAt: Date | null;
}) {
  return {
    enabled: s.enabled,
    dayOfWeek: s.dayOfWeek,
    hourUtc: s.hourUtc,
    recipients: Array.isArray(s.recipients)
      ? (s.recipients as unknown[]).filter((r): r is string => typeof r === "string")
      : [],
    lastSentAt: s.lastSentAt?.toISOString() ?? null,
  };
}

async function get(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage", { req });
  if ("error" in auth) return auth.error;
  const schedule = await prisma.reportSchedule.findUnique({
    where: { organizationId: auth.user.organizationId },
  });
  return NextResponse.json({ schedule: schedule ? shape(schedule) : DEFAULTS });
}

async function put(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage", { req });
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => ({}))) as {
    enabled?: unknown;
    dayOfWeek?: unknown;
    hourUtc?: unknown;
    recipients?: unknown;
  };
  const enabled = body.enabled === true;
  const dayOfWeek = Number(body.dayOfWeek);
  const hourUtc = Number(body.hourUtc);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)
    return apiError("invalid_day_of_week", 400, { message: "dayOfWeek must be an integer 0-6." });
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23)
    return apiError("invalid_hour", 400, { message: "hourUtc must be an integer 0-23." });
  const recipients = Array.isArray(body.recipients)
    ? [...new Set(body.recipients.filter((r): r is string => typeof r === "string").map((r) => r.trim()))].filter((r) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r),
      )
    : [];
  if (recipients.length > 20) return apiError("too_many_recipients", 400, { message: "At most 20 recipients." });

  const schedule = await prisma.reportSchedule.upsert({
    where: { organizationId: auth.user.organizationId },
    create: { organizationId: auth.user.organizationId, enabled, dayOfWeek, hourUtc, recipients },
    update: { enabled, dayOfWeek, hourUtc, recipients },
  });
  await writeAudit({
    organizationId: auth.user.organizationId,
    actorId: auth.user.id,
    action: "report.schedule_updated",
    entityType: "ReportSchedule",
    entityId: schedule.id,
    details: { enabled, dayOfWeek, hourUtc, recipientCount: recipients.length },
  }).catch(() => undefined); // A-API-04: audit failure must not turn an updated schedule into a 500.
  return NextResponse.json({ schedule: shape(schedule) });
}

export const GET = withApiErrors("reports/schedule", get);
export const PUT = withApiErrors("reports/schedule", put);
