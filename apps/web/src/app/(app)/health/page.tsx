import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@metricflock/auth";
import { loadHealthOverview } from "@/lib/health";
import { MetricCard, Card, Badge, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

// Phase 7.2 — integration health overview: one row per
// website+provider from the sync engine's health records. States:
// healthy (ok, recent success), error (last check failed), stale
// (ok but no success in 48h — quietly broken). Error text shown is
// the sanitized provider message stored by the sync engine.
export default async function HealthPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const { summary, rows, total, pageCount } = await loadHealthOverview(user, page);
  const tone = (state: string) =>
    (state === "healthy" ? "green" : state === "error" ? "red" : "amber") as "green" | "red" | "amber";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Integration health</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Per-website provider status from scheduled syncs and health checks. “Stale” means no successful sync in 48
          hours.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard label="Healthy" value={String(summary.healthy)} />
        <MetricCard label="Error" value={String(summary.error)} />
        <MetricCard label="Stale" value={String(summary.stale)} />
        <MetricCard label="No health record yet" value={String(summary.withoutRecord)} />
      </div>
      <Card className="p-4">
        {total === 0 ? (
          <EmptyState
            title="No health records yet"
            hint="Records appear after the first sync or health check for a mapped website."
          />
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500 dark:text-zinc-400">
                  <th scope="col" className="py-1 font-medium">
                    Website
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Provider
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    State
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Last success
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Last checked
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Last error
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.websiteId}-${r.provider}`} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="py-1">
                      <Link
                        href={`/websites/${r.websiteId}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {r.websiteName}
                      </Link>{" "}
                      <span className="text-zinc-500 dark:text-zinc-400">{r.domain}</span>
                    </td>
                    <td className="py-1">{r.provider}</td>
                    <td className="py-1">
                      <Badge tone={tone(r.state)}>{r.state}</Badge>
                    </td>
                    <td className="py-1 text-zinc-500 dark:text-zinc-400">
                      {r.lastSuccessAt?.slice(0, 16).replace("T", " ") ?? "—"}
                    </td>
                    <td className="py-1 text-zinc-500 dark:text-zinc-400">
                      {r.checkedAt.slice(0, 16).replace("T", " ")}
                    </td>
                    <td
                      className="max-w-xs truncate py-1 text-zinc-500 dark:text-zinc-400"
                      title={r.lastError ?? undefined}
                    >
                      {r.lastError ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pageCount > 1 && (
              <div className="mt-4 flex items-center gap-3 text-sm">
                {page > 1 && (
                  <Link href={`/health?page=${page - 1}`} className="text-blue-600 hover:underline dark:text-blue-400">
                    Previous
                  </Link>
                )}
                <span className="text-zinc-500 dark:text-zinc-400">
                  Page {page} of {pageCount}
                </span>
                {page < pageCount && (
                  <Link href={`/health?page=${page + 1}`} className="text-blue-600 hover:underline dark:text-blue-400">
                    Next
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
