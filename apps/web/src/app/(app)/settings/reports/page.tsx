import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card } from "@/components/ui";
import { ReportScheduleForm } from "./ReportScheduleForm";

export const dynamic = "force-dynamic";

// Weekly portfolio report settings (Phase 7.3). SUPER_ADMIN only —
// the APIs enforce organization.manage regardless of this page.
export default async function ReportsSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");
  const schedule = await prisma.reportSchedule.findUnique({
    where: { organizationId: user.organizationId },
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Weekly reports</h1>
      <Card className="p-4">
        <h2 className="font-semibold">Scheduled email report</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Once a week, the worker emails a portfolio summary (GA4, Search Console, AdSense and integration health for
          the last 28 days) built from synced snapshots. Leave recipients empty to send to all Super Admins. Sending
          needs the worker running and SMTP configured.
        </p>
        <div className="mt-4">
          <ReportScheduleForm
            initial={{
              enabled: schedule?.enabled ?? false,
              dayOfWeek: schedule?.dayOfWeek ?? 1,
              hourUtc: schedule?.hourUtc ?? 8,
              recipients: Array.isArray(schedule?.recipients)
                ? (schedule.recipients as unknown[]).filter((r): r is string => typeof r === "string")
                : [],
              lastSentAt: schedule?.lastSentAt?.toISOString() ?? null,
            }}
          />
        </div>
      </Card>
    </div>
  );
}
