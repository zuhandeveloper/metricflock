import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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

// Strict body shape (A-API-07). `recipients` is `unknown[]` here so the
// email pass below can name non-string entries in the 400; the ≤20 limit
// applies to the submitted list, before any email validation.
const scheduleSchema = z.object({
  enabled: z.boolean().default(false),
  dayOfWeek: z.number().int().min(0).max(6),
  hourUtc: z.number().int().min(0).max(23),
  recipients: z.array(z.unknown()).max(20).default([]),
});

// Map a shape failure to the route's established per-field error codes
// (invalid_day_of_week / invalid_hour / too_many_recipients) so existing
// clients keep the codes they already handle.
function scheduleShapeError(issues: z.ZodIssue[]): NextResponse {
  const field = issues[0]?.path[0];
  if (field === "dayOfWeek")
    return apiError("invalid_day_of_week", 400, { message: "dayOfWeek must be an integer 0-6." });
  if (field === "hourUtc") return apiError("invalid_hour", 400, { message: "hourUtc must be an integer 0-23." });
  if (field === "recipients") {
    if (issues[0]?.code === "too_big")
      return apiError("too_many_recipients", 400, { message: "At most 20 recipients." });
    return apiError("invalid_recipients", 400, {
      message: "recipients must be an array of email addresses.",
    });
  }
  return apiError("invalid_input", 400, { message: "Invalid schedule input." });
}

async function put(req: NextRequest) {
  const auth = await requireApiAuth("organization.manage", { req });
  if ("error" in auth) return auth.error;
  const raw = (await req.json().catch(() => ({}))) as unknown;
  // A-API-07: strict zod validation — no coercion, nothing silently
  // dropped. The pre-fix code filtered invalid recipients by regex,
  // coerced `enabled` (`=== true`) and `dayOfWeek`/`hourUtc` (`Number()`),
  // and checked the ≤20 limit only after filtering, so a typo'd recipient
  // saved successfully with a silently different list.
  const parsed = scheduleSchema.safeParse(raw);
  if (!parsed.success) return scheduleShapeError(parsed.error.issues);
  const { enabled, dayOfWeek, hourUtc } = parsed.data;
  // Recipients: trim + dedupe + drop blank lines (normalization the UI
  // also does), then every remaining entry must be a valid email — an
  // invalid address is a 400 listing it, never a silent drop.
  const emailSchema = z.string().email();
  const seen = new Set<string>();
  const invalidRecipients: unknown[] = [];
  const recipients: string[] = [];
  for (const entry of parsed.data.recipients) {
    if (typeof entry !== "string") {
      invalidRecipients.push(entry);
      continue;
    }
    const address = entry.trim();
    if (!address) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    if (!emailSchema.safeParse(address).success) invalidRecipients.push(address);
    else recipients.push(address);
  }
  if (invalidRecipients.length > 0)
    return apiError("invalid_recipients", 400, {
      message: `Invalid recipient email addresses: ${invalidRecipients.map((r) => JSON.stringify(r)).join(", ")}.`,
      invalidRecipients,
    });

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
