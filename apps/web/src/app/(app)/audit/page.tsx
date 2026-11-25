import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import type { Prisma } from "@metricflock/db";
import { Card, EmptyState } from "@/components/ui";
export const dynamic = "force-dynamic";

// A-FE-15: paginated like the websites list (50/page with a total) —
// the old `take: 100` made every entry past row 100 unreachable from
// the UI even though audit rows are retained for 365 days. Filters
// (action, actor, date range) are server-side via search params. The
// total comes from the organization relation's filtered _count: one
// aggregate query, same cost as auditLog.count.
const PAGE_SIZE = 50;
export default async function AuditPage({
  searchParams,
}: {
  searchParams?: Promise<{ action?: string; actor?: string; from?: string; to?: string; page?: string }>;
} = {}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN")
    return (
      <Card className="p-6">
        <h1 className="text-lg font-bold">Permission denied</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Audit logs are visible to Super Admins only.</p>
      </Card>
    );
  const { action, actor, from, to, page: pageParam } = (await searchParams) ?? {};
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  const createdAt: Prisma.DateTimeFilter = {};
  if (fromDate && !Number.isNaN(fromDate.getTime())) createdAt.gte = fromDate;
  // `to` is a date input (yyyy-mm-dd): include the whole day.
  if (toDate && !Number.isNaN(toDate.getTime())) createdAt.lt = new Date(toDate.getTime() + 86_400_000);
  const filters: Prisma.AuditLogWhereInput = {
    ...(action ? { action: { contains: action, mode: "insensitive" } } : {}),
    ...(actor ? { actor: { email: { contains: actor, mode: "insensitive" } } } : {}),
    ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
  };
  const hasFilters = Boolean(action || actor || from || to);
  const [org, logs] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { _count: { select: { auditLogs: { where: filters } } } },
    }),
    prisma.auditLog.findMany({
      where: { organizationId: user.organizationId, ...filters },
      include: { actor: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  const total = org?._count?.auditLogs ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (actor) params.set("actor", actor);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/audit?${qs}` : "/audit";
  };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Audit Log</h1>
      <form className="flex flex-wrap gap-2">
        <label htmlFor="audit-action-filter" className="sr-only">
          Filter by action
        </label>
        <input
          id="audit-action-filter"
          name="action"
          defaultValue={action ?? ""}
          placeholder="Action contains…"
          className="w-full max-w-xs rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <label htmlFor="audit-actor-filter" className="sr-only">
          Filter by actor email
        </label>
        <input
          id="audit-actor-filter"
          name="actor"
          defaultValue={actor ?? ""}
          placeholder="Actor email contains…"
          className="w-full max-w-xs rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <label htmlFor="audit-from-filter" className="sr-only">
          From date
        </label>
        <input
          id="audit-from-filter"
          type="date"
          name="from"
          defaultValue={from ?? ""}
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <label htmlFor="audit-to-filter" className="sr-only">
          To date
        </label>
        <input
          id="audit-to-filter"
          type="date"
          name="to"
          defaultValue={to ?? ""}
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-white dark:text-zinc-900">
          Filter
        </button>
      </form>
      <Card className="p-4">
        {logs.length === 0 ? (
          hasFilters ? (
            <EmptyState title="No audit entries match" hint="Try widening the filters." />
          ) : (
            <EmptyState title="No audit entries yet" />
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500 dark:text-zinc-400">
                  <th scope="col" className="py-2">
                    Time
                  </th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-2">{l.createdAt.toISOString()}</td>
                    <td>{l.actor?.email ?? "system"}</td>
                    <td>{l.action}</td>
                    <td>
                      {l.entityType ?? "—"} {l.entityId ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <nav aria-label="Audit log pagination" className="mt-3 flex items-center justify-between text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">
              Page {page} of {totalPages} · {total} entries
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
