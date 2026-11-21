"use client";
import { useQuery } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import { Card, EmptyState } from "@/components/ui";
async function fetchJson(url: string) {
  const r = await fetch(url);
  const body = await r.json().catch(() => null);
  // FE-2: non-2xx is an error state, not data — previously a 502 rendered
  // as "Source: undefined · Freshness: undefined".
  if (!r.ok) {
    const code = (body as { error?: string } | null)?.error ?? `http_${r.status}`;
    throw new Error(code);
  }
  return body;
}

const METRIC_LABELS: Record<string, string> = {
  totalUsers: "Total users",
  activeUsers: "Active users",
  newUsers: "New users",
  sessions: "Sessions",
  screenPageViews: "Page views",
  engagedSessions: "Engaged sessions",
  engagementRate: "Engagement rate",
  averageEngagementTime: "Avg. engagement time",
  bounceRate: "Bounce rate",
  eventCount: "Events",
  keyEvents: "Key events",
  sessionConversionRate: "Session conversion rate",
  clicks: "Clicks",
  impressions: "Impressions",
  avgCtr: "Avg. CTR",
  avgPosition: "Avg. position",
  ESTIMATED_EARNINGS: "Estimated earnings",
  PAGE_VIEWS: "Page views",
  IMPRESSIONS: "Impressions",
  CLICKS: "Clicks",
  CTR: "CTR",
  CPC: "CPC",
  PAGE_RPM: "Page RPM",
  IMPRESSION_RPM: "Impression RPM",
};
const PERCENT_METRICS = new Set(["engagementRate", "bounceRate", "sessionConversionRate", "avgCtr", "CTR"]);

function formatMetric(key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v !== "number") return String(v);
  if (PERCENT_METRICS.has(key)) return `${(v * 100).toFixed(1)}%`;
  if (key === "averageEngagementTime") {
    const m = Math.floor(v / 60);
    const s = Math.round(v % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function ErrorNote({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = error instanceof Error ? error.message : "unknown_error";
  return (
    <div role="alert" className="mt-2 text-sm">
      <p className="text-red-600">Couldn&apos;t load this data ({code}).</p>
      <button type="button" onClick={onRetry} className="mt-1 text-blue-600 hover:underline">
        Retry
      </button>
    </div>
  );
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
  // FE-4: render only the parts that exist — never "undefined".
  const parts: string[] = [];
  if (data.dataSource) parts.push(`Source: ${data.dataSource}`);
  if (data.freshness) parts.push(`Freshness: ${data.freshness}`);
  parts.push(`Last synced: ${data.lastSyncedAt ?? "never"}`);
  return <p className="text-xs text-zinc-500">{parts.join(" · ")}</p>;
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
        ) : rt.isError ? (
          <ErrorNote error={rt.error} onRetry={() => rt.refetch()} />
        ) : rt.data?.status === "ok" ? (
          <>
            <StatusNote data={rt.data} />
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
          </>
        ) : (
          <StatusNote data={rt.data} />
        )}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Historical overview</h2>
        {ov.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : ov.isError ? (
          <ErrorNote error={ov.error} onRetry={() => ov.refetch()} />
        ) : ov.data?.status === "ok" ? (
          <>
            <StatusNote data={ov.data} />
            {ov.data.data.sampling?.sampled && (
              <p className="mt-1 text-xs text-amber-600">
                Sampled data: GA4 read {ov.data.data.sampling.samplesReadCount?.toLocaleString()} of{" "}
                {ov.data.data.sampling.samplingSpaceSize?.toLocaleString()} sessions — figures are estimates.
              </p>
            )}
            {ov.data.data.sampling?.subjectToThresholding && (
              <p className="mt-1 text-xs text-amber-600">
                Some data was withheld by GA4 thresholding (low-volume segments).
              </p>
            )}
            <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
              {Object.entries(ov.data.data.summary ?? {})
                .slice(0, 8)
                .map(([k, v]) => (
                  <div key={k}>
                    <p className="text-lg font-bold">{formatMetric(k, v)}</p>
                    <p className="text-xs text-zinc-500">{METRIC_LABELS[k] ?? k}</p>
                  </div>
                ))}
            </div>
            {chartRows.length > 0 && (
              <div className="mt-4 h-64" role="img" aria-label="Line chart of daily active users and page views">
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
          ) : pages.isError ? (
            <ErrorNote error={pages.error} onRetry={() => pages.refetch()} />
          ) : pages.data?.status === "ok" ? (
            <div className="mt-2 h-56" role="img" aria-label="Bar chart of top pages by views">
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
          ) : gsc.isError ? (
            <ErrorNote error={gsc.error} onRetry={() => gsc.refetch()} />
          ) : gsc.data?.status === "ok" ? (
            <>
              <StatusNote data={gsc.data} />
              <div className="mt-2 grid grid-cols-2 gap-3">
                {Object.entries(gsc.data.data.totals ?? {}).map(([k, v]) => (
                  <div key={k}>
                    <p className="text-lg font-bold">{formatMetric(k, v)}</p>
                    <p className="text-xs text-zinc-500">{METRIC_LABELS[k] ?? k}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <StatusNote data={gsc.data} />
          )}
        </Card>
      </div>
      <Card className="p-4">
        <h2 className="font-semibold">AdSense — estimated earnings (not finalized payments)</h2>
        {ads.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : ads.isError ? (
          <ErrorNote error={ads.error} onRetry={() => ads.refetch()} />
        ) : ads.data?.status === "ok" ? (
          <>
            <StatusNote data={ads.data} />
            <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
              {Object.entries(ads.data.data.totalsByMetric ?? {}).map(([k, v]) => (
                <div key={k}>
                  <p className="text-lg font-bold">{formatMetric(k, v)}</p>
                  <p className="text-xs text-zinc-500">{METRIC_LABELS[k] ?? k}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-sm text-zinc-500">
              {ads.data.data.note} · {(ads.data.data.rows ?? []).length} daily rows returned.
            </p>
          </>
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
