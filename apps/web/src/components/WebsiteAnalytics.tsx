"use client";
import { useQuery } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import { Card, EmptyState } from "@/components/ui";
async function fetchJson(url: string) {
  const r = await fetch(url);
  return r.json();
}
function StatusNote({
  data,
}: {
  data:
    | {
        status?: string;
        unavailableWebsites?: { reason: string }[];
        lastSyncedAt?: string | null;
        dataSource?: string;
        freshness?: string;
      }
    | undefined;
}) {
  if (!data) return null;
  if (data.status === "not_connected")
    return (
      <EmptyState
        title="Not connected"
        hint="No active Google connection for this website or its team. Connect an account from Integrations, then map a property."
      />
    );
  if (data.status === "missing_data")
    return (
      <EmptyState
        title="No property mapped"
        hint={data.unavailableWebsites?.[0]?.reason ?? "Map a Google property to this website first."}
      />
    );
  return (
    <p className="text-xs text-zinc-500">
      Source: {data.dataSource} · Freshness: {data.freshness} · Last synced: {data.lastSyncedAt ?? "never"}
    </p>
  );
}
export default function WebsiteAnalytics({ websiteId, range }: { websiteId: string; range: string }) {
  const rt = useQuery({
    queryKey: ["realtime", websiteId],
    queryFn: () => fetchJson(`/api/analytics/realtime?websiteId=${websiteId}`),
    refetchInterval: 30_000,
  });
  const ov = useQuery({
    queryKey: ["overview", websiteId, range],
    queryFn: () => fetchJson(`/api/analytics/overview?websiteId=${websiteId}&range=${range}`),
  });
  const pages = useQuery({
    queryKey: ["pages", websiteId, range],
    queryFn: () => fetchJson(`/api/analytics/pages?websiteId=${websiteId}&range=${range}`),
  });
  const gsc = useQuery({
    queryKey: ["gsc", websiteId, range],
    queryFn: () => fetchJson(`/api/analytics/search-console?websiteId=${websiteId}&range=${range}`),
  });
  const ads = useQuery({
    queryKey: ["adsense", websiteId, range],
    queryFn: () => fetchJson(`/api/analytics/adsense?websiteId=${websiteId}&range=${range}`),
  });
  const chartRows = (ov.data?.data?.rows ?? []).map((r: Record<string, string | number>) => ({
    date: r.dimension0,
    users: r.activeUsers ?? r.totalUsers ?? 0,
    views: r.screenPageViews ?? 0,
  }));
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="font-semibold">Realtime — active users (last 30 min, approximate)</h2>
        {rt.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : rt.data?.status === "ok" ? (
          <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <p className="text-2xl font-bold">{rt.data.data.activeUsers}</p>
              <p className="text-xs text-zinc-500">Active users</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{rt.data.data.eventCount}</p>
              <p className="text-xs text-zinc-500">Events</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-zinc-500">Top countries</p>
              {(rt.data.data.byCountry ?? []).slice(0, 5).map((c: { name: string; activeUsers: number }) => (
                <p key={c.name} className="text-sm">
                  {c.name}: {c.activeUsers}
                </p>
              ))}
            </div>
          </div>
        ) : (
          <StatusNote data={rt.data} />
        )}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Historical overview</h2>
        {ov.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : ov.data?.status === "ok" ? (
          <>
            <StatusNote data={ov.data} />
            <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
              {Object.entries(ov.data.data.summary ?? {})
                .slice(0, 8)
                .map(([k, v]) => (
                  <div key={k}>
                    <p className="text-lg font-bold">{typeof v === "number" ? v.toLocaleString() : String(v)}</p>
                    <p className="text-xs text-zinc-500">{k}</p>
                  </div>
                ))}
            </div>
            {chartRows.length > 0 && (
              <div className="mt-4 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartRows}>
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Line type="monotone" dataKey="users" stroke="#2563eb" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="views" stroke="#059669" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        ) : (
          <StatusNote data={ov.data} />
        )}
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h2 className="font-semibold">Top pages</h2>
          {pages.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : pages.data?.status === "ok" ? (
            <div className="mt-2 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={(pages.data.data.rows ?? []).slice(0, 8).map((r: Record<string, string | number>) => ({
                    page: String(r.dimension0).slice(0, 24),
                    views: r.screenPageViews ?? 0,
                  }))}
                >
                  <XAxis dataKey="page" hide />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="views" fill="#2563eb" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <StatusNote data={pages.data} />
          )}
        </Card>
        <Card className="p-4">
          <h2 className="font-semibold">Search Console (delayed 2–3 days, not real-time)</h2>
          {gsc.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : gsc.data?.status === "ok" ? (
            <div className="mt-2 grid grid-cols-2 gap-3">
              {Object.entries(gsc.data.data.totals ?? {}).map(([k, v]) => (
                <div key={k}>
                  <p className="text-lg font-bold">
                    {typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v)}
                  </p>
                  <p className="text-xs text-zinc-500">{k}</p>
                </div>
              ))}
            </div>
          ) : (
            <StatusNote data={gsc.data} />
          )}
        </Card>
      </div>
      <Card className="p-4">
        <h2 className="font-semibold">AdSense — estimated earnings (not finalized payments)</h2>
        {ads.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : ads.data?.status === "ok" ? (
          <p className="mt-2 text-sm">
            {ads.data.data.note} · {(ads.data.data.rows ?? []).length} rows returned.
          </p>
        ) : (
          <StatusNote data={ads.data} />
        )}
        <a
          className="mt-3 inline-block text-sm text-blue-600 hover:underline"
          href={`/api/analytics/pages?websiteId=${websiteId}&range=${range}&format=csv`}
        >
          Download pages CSV
        </a>
      </Card>
    </div>
  );
}
