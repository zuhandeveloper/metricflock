import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import { Card, MetricCard, EmptyState, Badge } from "@/components/ui";
import { loadInsights } from "@/lib/insights";

export const dynamic = "force-dynamic";

const fmt = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined
    ? "—"
    : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);

// SEO/revenue intelligence (Phase 7.4). Everything here is derived
// from synced 28-day snapshots — striking-distance and low-CTR
// queries from Search Console rows, earnings patterns from AdSense
// daily rows, channel mix from GA4 traffic rows.
export default async function InsightsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { range, summary, websites, unavailableCount, truncated } = await loadInsights(user);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Insights</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Last 28 days ({range.startDate} to {range.endDate}), from synced snapshots.
          {unavailableCount > 0 && ` ${unavailableCount} website(s) have no snapshot yet.`}
          {truncated && ` Showing insights for the first 50 websites.`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Est. earnings (portfolio)" value={fmt(summary.totalEarnings, 2)} />
        <MetricCard label="Blended page RPM" value={fmt(summary.blendedPageRpm, 2)} />
        <MetricCard label="Earnings / 1k sessions" value={fmt(summary.earningsPerThousandSessions, 2)} />
        <MetricCard
          label="SEO opportunities"
          value={String(summary.strikingDistanceQueries + summary.lowCtrQueries)}
          sub={`${summary.strikingDistanceQueries} striking-distance · ${summary.lowCtrQueries} low-CTR`}
        />
      </div>

      {websites.length === 0 && (
        <EmptyState
          title="No insights yet"
          hint="Insights appear after the worker syncs Search Console, AdSense and GA4 snapshots for your websites."
        />
      )}

      {websites.map((w) => (
        <Card key={w.websiteId} className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{w.name}</h2>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">{w.domain}</span>
            {w.seo?.truncated && <Badge tone="amber">Search Console rows truncated</Badge>}
          </div>

          {w.revenue && (
            <p className="mt-2 text-sm">
              Earnings <strong>{fmt(w.revenue.totalEarnings, 2)}</strong> · avg/day {fmt(w.revenue.avgDailyEarnings, 2)}
              {w.revenue.bestDay && (
                <>
                  {" "}
                  · best day {w.revenue.bestDay.date} ({fmt(w.revenue.bestDay.earnings, 2)})
                </>
              )}
              {w.revenue.trendPercent !== null && (
                <>
                  {" "}
                  · trend {w.revenue.trendPercent >= 0 ? "+" : ""}
                  {w.revenue.trendPercent.toFixed(0)}% (second half vs first)
                </>
              )}
            </p>
          )}

          {w.channels.length > 0 && (
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Channels: {w.channels.map((c) => `${c.channel} ${c.sharePercent.toFixed(0)}%`).join(" · ")}
            </p>
          )}

          {w.seo && w.seo.strikingDistance.length > 0 && (
            <div className="mt-3">
              <h3 className="text-sm font-semibold">Striking-distance queries (position 4–20)</h3>
              <table className="mt-1 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
                    <th scope="col" className="py-1 pr-2">
                      Query
                    </th>
                    <th scope="col" className="py-1 pr-2">
                      Position
                    </th>
                    <th scope="col" className="py-1 pr-2">
                      Impressions
                    </th>
                    <th scope="col" className="py-1">
                      CTR
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {w.seo.strikingDistance.map((q) => (
                    <tr key={q.query} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-1 pr-2">{q.query}</td>
                      <td className="py-1 pr-2">{fmt(q.position, 1)}</td>
                      <td className="py-1 pr-2">{fmt(q.impressions)}</td>
                      <td className="py-1">{pct(q.ctr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {w.seo && w.seo.lowCtr.length > 0 && (
            <div className="mt-3">
              <h3 className="text-sm font-semibold">High impressions, below-average CTR</h3>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                {w.seo.lowCtr.map((q) => `${q.query} (${fmt(q.impressions)} impr., ${pct(q.ctr)})`).join(" · ")}
              </p>
            </div>
          )}

          {w.seo && w.seo.topQueries.length > 0 && (
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
              Top queries:{" "}
              {w.seo.topQueries
                .slice(0, 5)
                .map((q) => `${q.query} (${fmt(q.clicks)} clicks)`)
                .join(" · ")}
            </p>
          )}
        </Card>
      ))}
    </div>
  );
}
