import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, Badge, EmptyState } from "@/components/ui";
import { RequeueButton } from "./RequeueButton";
export const dynamic = "force-dynamic";

// Dead-letter view (Stage 8 OPS-4 API, UI added in the UI-completion
// pass): terminally failed sync jobs with retained payloads. The API
// (/api/sync/failed, /api/sync/requeue) is SUPER_ADMIN-only, so the
// page mirrors that gate.
export default async function SyncJobsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Sync jobs</h1>
        <EmptyState title="Super Admin only" hint="Failed sync jobs and requeue are restricted to Super Admins." />
      </div>
    );
  }
  const [failed, recent] = await Promise.all([
    prisma.analyticsSyncJob.findMany({
      where: { status: "FAILED" },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: { website: { select: { name: true, domain: true } } },
    }),
    prisma.analyticsSyncJob.findMany({
      where: { status: { in: ["PENDING", "RUNNING", "SUCCEEDED"] } },
      orderBy: { updatedAt: "desc" },
      take: 20,
      include: { website: { select: { name: true, domain: true } } },
    }),
  ]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Sync jobs</h1>
      <Card className="p-4">
        <h2 className="font-semibold">Failed jobs (dead-letter)</h2>
        {failed.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500">No failed jobs.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500">
                <th scope="col" className="py-2">
                  Website
                </th>
                <th scope="col">Type</th>
                <th scope="col">Attempts</th>
                <th scope="col">Last error</th>
                <th scope="col">Updated</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {failed.map((j) => (
                <tr key={j.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2">
                    {j.website?.name ?? j.websiteId}
                    <span className="block text-xs text-zinc-500">{j.website?.domain ?? ""}</span>
                  </td>
                  <td>{j.type}</td>
                  <td>{j.attempts}</td>
                  <td className="max-w-xs truncate text-xs text-red-700" title={j.lastError ?? ""}>
                    {j.lastError ?? "—"}
                  </td>
                  <td className="text-xs text-zinc-500">{j.updatedAt.toISOString()}</td>
                  <td className="text-right">
                    <RequeueButton jobId={j.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Recent jobs</h2>
        {recent.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500">
            No sync jobs yet. Jobs appear after the worker runs or a manual sync is queued.
          </p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500">
                <th scope="col" className="py-2">
                  Website
                </th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((j) => (
                <tr key={j.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2">
                    {j.website?.name ?? j.websiteId}
                    <span className="block text-xs text-zinc-500">{j.website?.domain ?? ""}</span>
                  </td>
                  <td>{j.type}</td>
                  <td>
                    <Badge tone={j.status === "SUCCEEDED" ? "green" : j.status === "RUNNING" ? "blue" : "amber"}>
                      {j.status}
                    </Badge>
                  </td>
                  <td className="text-xs text-zinc-500">{j.updatedAt.toISOString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
