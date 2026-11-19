import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { Card, Badge, EmptyState } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function WebsitesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { q, status } = await searchParams;
  const ids = await listAccessibleWebsiteIds(user);
  const websites = await prisma.website.findMany({
    where: { organizationId: user.organizationId, ...(ids ? { id: { in: ids } } : {}), ...(status ? { status: status as never } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { domain: { contains: q, mode: "insensitive" } }] } : {}) },
    include: { team: { select: { name: true } }, integrations: { select: { provider: true, mappingStatus: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Websites</h1>
      <form className="flex gap-2">
        <input name="q" defaultValue={q ?? ""} placeholder="Search name or domain…" className="w-full max-w-sm rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        <select name="status" defaultValue={status ?? ""} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          <option value="">All statuses</option>{["ACTIVE", "PENDING_SETUP", "DISCONNECTED", "TRANSFER_PENDING", "SOLD", "ARCHIVED"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-white dark:text-zinc-900">Filter</button>
      </form>
      <Card className="p-4">
        {websites.length === 0 ? <EmptyState title="No websites match" hint="Add a website via POST /api/websites (Super Admin / Team Admin)." /> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-zinc-500"><th className="py-2">Website</th><th>Team</th><th>Status</th><th>Integrations</th><th></th></tr></thead>
            <tbody>{websites.map((w) => (
              <tr key={w.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-2 font-medium">{w.name}<span className="block text-xs text-zinc-500">{w.domain}</span></td>
                <td>{w.team?.name ?? "—"}</td>
                <td><Badge tone={w.status === "ACTIVE" ? "green" : w.status === "PENDING_SETUP" ? "amber" : "zinc"}>{w.status}</Badge></td>
                <td>{w.integrations.map((i) => `${i.provider}:${i.mappingStatus}`).join(", ") || "none"}</td>
                <td className="text-right"><Link href={`/websites/${w.id}`} className="text-blue-600 hover:underline">Open →</Link></td>
              </tr>))}</tbody>
          </table>)}
      </Card>
    </div>
  );
}
