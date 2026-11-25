import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState, Badge } from "@/components/ui";
import TransferActions from "./TransferActions";
export const dynamic = "force-dynamic";

// A-FE-15: paginated like the websites list (50/page with a total) —
// the old `take: 50` hid every transfer past row 50.
const PAGE_SIZE = 50;
export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const where = { website: { organizationId: user.organizationId } };
  const [totalTransfers, transfers] = await Promise.all([
    prisma.websiteTransfer.count({ where }),
    prisma.websiteTransfer.findMany({
      where,
      include: {
        website: { select: { name: true, domain: true } },
        fromTeam: { select: { name: true } },
        toTeam: { select: { name: true } },
        initiatedBy: { select: { email: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalTransfers / PAGE_SIZE));
  const pageHref = (p: number) => (p > 1 ? `/transfers?page=${p}` : "/transfers");
  const adminTeamIds = new Set(
    (
      await prisma.teamMember.findMany({
        where: { userId: user.id, isAdmin: true },
        select: { teamId: true },
      })
    ).map((m) => m.teamId),
  );
  const isSuperAdmin = user.role === "SUPER_ADMIN";
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Website Transfers</h1>
      <Card className="p-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Transfers are two-sided: the destination team&apos;s admin accepts, connects their own Google account, then
          completes — the website moves only at completion. OAuth tokens never move between owners; old property
          mappings are cleared at handover and the new team re-maps. Open transfers expire after 7 days. Historical
          reports and audit logs are preserved.
        </p>
      </Card>
      <Card className="p-4">
        {transfers.length === 0 ? (
          <EmptyState
            title="No transfers yet"
            hint="To start a transfer, open a website's page and use the Transfer ownership form."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500 dark:text-zinc-400">
                  <th scope="col" className="py-2">
                    Website
                  </th>
                  <th scope="col">From → To</th>
                  <th scope="col">Status</th>
                  <th scope="col">By</th>
                  <th scope="col">Initiated</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 font-medium">{t.website.name}</td>
                    <td>
                      {t.fromTeam?.name ?? "—"} → {t.toTeam.name}
                    </td>
                    <td>
                      <Badge
                        tone={
                          t.status === "COMPLETED"
                            ? "green"
                            : t.status === "CANCELLED" || t.status === "EXPIRED" || t.status === "FAILED"
                              ? "zinc"
                              : "amber"
                        }
                      >
                        {t.status}
                      </Badge>
                    </td>
                    <td>{t.initiatedBy.email}</td>
                    <td>{t.initiatedAt.toISOString().slice(0, 10)}</td>
                    <td>
                      <TransferActions
                        transferId={t.id}
                        status={t.status}
                        canDestination={isSuperAdmin || adminTeamIds.has(t.toTeamId)}
                        canCancel={isSuperAdmin || t.initiatedById === user.id}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <nav aria-label="Transfers pagination" className="mt-3 flex items-center justify-between text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">
              Page {page} of {totalPages} · {totalTransfers} transfers
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
