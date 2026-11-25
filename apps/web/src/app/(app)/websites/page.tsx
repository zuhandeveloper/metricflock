import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import type { Prisma } from "@metricflock/db";
import { listAccessibleWebsiteIds } from "@metricflock/auth";
import { Card, Badge, EmptyState } from "@/components/ui";
import { AddWebsiteForm } from "./WebsiteForms";
export const dynamic = "force-dynamic";

// A-FE-02: paginated like the dashboard (50/page with a total) — the old
// `take: 100` silently hid every website past row 100.
const PAGE_SIZE = 50;
export default async function WebsitesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const canManage = hasPermission(user.role, "website.manage");
  const { q, status, page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const teams = await prisma.team.findMany({
    where: { organizationId: user.organizationId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const ids = await listAccessibleWebsiteIds(user);
  const where: Prisma.WebsiteWhereInput = {
    organizationId: user.organizationId,
    ...(ids ? { id: { in: ids } } : {}),
    ...(status ? { status: status as never } : {}),
    ...(q
      ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { domain: { contains: q, mode: "insensitive" } }] }
      : {}),
  };
  const [totalWebsites, websites] = await Promise.all([
    prisma.website.count({ where }),
    prisma.website.findMany({
      where,
      include: { team: { select: { name: true } }, integrations: { select: { provider: true, mappingStatus: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalWebsites / PAGE_SIZE));
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/websites?${qs}` : "/websites";
  };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Websites</h1>
      {canManage && (
        <Card className="p-4">
          <h2 className="mb-2 font-semibold">Add website</h2>
          <AddWebsiteForm teams={teams} />
        </Card>
      )}
      <form className="flex gap-2">
        <label htmlFor="website-search" className="sr-only">
          Search name or domain
        </label>
        <input
          id="website-search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search name or domain…"
          className="w-full max-w-sm rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <label htmlFor="website-status-filter" className="sr-only">
          Filter by status
        </label>
        <select
          id="website-status-filter"
          name="status"
          defaultValue={status ?? ""}
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">All statuses</option>
          {["ACTIVE", "PENDING_SETUP", "DISCONNECTED", "TRANSFER_PENDING", "SOLD", "ARCHIVED"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-white dark:text-zinc-900">
          Filter
        </button>
      </form>
      <Card className="p-4">
        {websites.length === 0 ? (
          <EmptyState
            title="No websites match"
            hint={canManage ? "Add your first website with the form above." : "No websites are visible to you yet."}
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 dark:text-zinc-400">
                <th scope="col" className="py-2">
                  Website
                </th>
                <th scope="col">Team</th>
                <th scope="col">Status</th>
                <th scope="col">Integrations</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {websites.map((w) => (
                <tr key={w.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 font-medium">
                    {w.name}
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">{w.domain}</span>
                  </td>
                  <td>{w.team?.name ?? "—"}</td>
                  <td>
                    <Badge tone={w.status === "ACTIVE" ? "green" : w.status === "PENDING_SETUP" ? "amber" : "zinc"}>
                      {w.status}
                    </Badge>
                  </td>
                  <td>{w.integrations.map((i) => `${i.provider}:${i.mappingStatus}`).join(", ") || "none"}</td>
                  <td className="text-right">
                    <Link href={`/websites/${w.id}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {totalPages > 1 && (
          <nav aria-label="Websites pagination" className="mt-3 flex items-center justify-between text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">
              Page {page} of {totalPages} · {totalWebsites} websites
            </span>
            <span className="flex gap-2">
              {page > 1 && (
                <Link
                  href={pageHref(page - 1)}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  ← Previous
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={pageHref(page + 1)}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Next →
                </Link>
              )}
            </span>
          </nav>
        )}
      </Card>
    </div>
  );
}
