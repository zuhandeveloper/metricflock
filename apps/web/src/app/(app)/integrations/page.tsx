import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState, ConnectionStatus } from "@/components/ui";
import { providersMissingScopes } from "@metricflock/google/oauth";
import { adManagerEnabled } from "@metricflock/google/ad-manager";
import { DisconnectButton, DiscoverButton, MapPropertyForm } from "./ConnectionActions";
export const dynamic = "force-dynamic";

// A-FE-03: this page used to load every connection (with all discovered
// properties), every team and every website unbounded — at 100+ sites it
// was the heaviest server-component render in the app. Connections are
// paginated (20/page, like the dashboard/websites pages) and the
// team/website option lists are capped at 20, narrowed by the page-level
// search; owner names are fetched only for the connections on the page.
const CONNECTIONS_PAGE_SIZE = 20;
const OPTIONS_LIMIT = 20;
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ oauth?: string; page?: string; q?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const canManage = hasPermission(user.role, "google.connection.manage");
  const { oauth, page: pageParam, q } = await searchParams;
  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  // Page-level search narrows the team/website option lists (connect
  // selects and map forms). Empty means "no filter", not "no results".
  const query = q?.trim() ? q.trim() : undefined;
  const nameMatch = query ? { contains: query, mode: "insensitive" as const } : undefined;
  const teamOptionsWhere = { organizationId: user.organizationId, ...(nameMatch ? { name: nameMatch } : {}) };
  const websiteOptionsWhere = { organizationId: user.organizationId, ...(nameMatch ? { name: nameMatch } : {}) };
  const [totalConnections, connections, totalTeams, totalWebsites] = await Promise.all([
    prisma.googleConnection.count({ where: { organizationId: user.organizationId } }),
    prisma.googleConnection.findMany({
      where: { organizationId: user.organizationId },
      include: {
        health: { orderBy: { checkedAt: "desc" }, take: 3 },
        properties: { include: { integrations: { include: { website: { select: { name: true } } } } } },
        searchConsoleProps: { include: { integrations: { include: { website: { select: { name: true } } } } } },
        adsenseAccounts: { include: { integrations: { include: { website: { select: { name: true } } } } } },
        adManagerNetworks: { include: { integrations: { include: { website: { select: { name: true } } } } } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * CONNECTIONS_PAGE_SIZE,
      take: CONNECTIONS_PAGE_SIZE,
    }),
    prisma.team.count({ where: teamOptionsWhere }),
    prisma.website.count({ where: websiteOptionsWhere }),
  ]);
  // Owner names are only needed for the connections on this page.
  const teamOwnerIds = [...new Set(connections.filter((c) => c.ownerType === "TEAM").map((c) => c.ownerId))];
  const websiteOwnerIds = [...new Set(connections.filter((c) => c.ownerType === "WEBSITE").map((c) => c.ownerId))];
  const [ownerTeams, ownerWebsites, teamOptions, websiteOptions] = await Promise.all([
    prisma.team.findMany({
      where: { organizationId: user.organizationId, id: { in: teamOwnerIds } },
      select: { id: true, name: true },
    }),
    prisma.website.findMany({
      where: { organizationId: user.organizationId, id: { in: websiteOwnerIds } },
      select: { id: true, name: true },
    }),
    prisma.team.findMany({
      where: teamOptionsWhere,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: OPTIONS_LIMIT,
    }),
    prisma.website.findMany({
      where: websiteOptionsWhere,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: OPTIONS_LIMIT,
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalConnections / CONNECTIONS_PAGE_SIZE));
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/integrations?${qs}` : "/integrations";
  };
  const ownerName = (c: (typeof connections)[number]) =>
    c.ownerType === "TEAM"
      ? (ownerTeams.find((t) => t.id === c.ownerId)?.name ?? c.ownerId)
      : (ownerWebsites.find((w) => w.id === c.ownerId)?.name ?? c.ownerId);
  const noOptionsMatch = query !== undefined && teamOptions.length === 0 && websiteOptions.length === 0;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Integrations</h1>
      {oauth && (
        <Card className="p-3 text-sm">
          OAuth result: <strong>{oauth}</strong>
          {oauth === "no_refresh_token" &&
            " — Google did not return a refresh token. Re-authorize with the consent prompt."}
          {oauth === "scope_missing" &&
            " — Google returned no granted scopes, so the connection was not saved. Re-authorize and grant all requested scopes."}
          {(oauth === "token_exchange_failed" || oauth === "profile_failed" || oauth === "connection_failed") &&
            " — the connection could not be completed. Try connecting again."}
          {oauth === "connected" && " — account connected. Discover properties, then map them to websites."}
        </Card>
      )}
      <Card className="p-4">
        <h2 className="font-semibold">Connect a Google account</h2>
        <p className="text-sm text-zinc-500">
          Team-level accounts serve all websites in the team; website-level accounts take priority for that website.
        </p>
        {totalTeams === 0 && totalWebsites === 0 && !query ? (
          <p className="mt-2 text-sm text-zinc-500">
            Create a team first (Teams page), then add a website — connections attach to a team or a website.
          </p>
        ) : (
          <>
            <form className="mt-3 flex gap-2">
              <label htmlFor="integrations-search" className="sr-only">
                Search teams and websites
              </label>
              <input
                id="integrations-search"
                name="q"
                defaultValue={query ?? ""}
                placeholder="Search teams and websites…"
                className="w-full max-w-sm rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white dark:bg-white dark:text-zinc-900">
                Search
              </button>
              {query && (
                <Link
                  href="/integrations"
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  Clear
                </Link>
              )}
            </form>
            {noOptionsMatch ? (
              <p className="mt-2 text-sm text-zinc-500">No teams or websites match “{query}”.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {teamOptions.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    No teams{query ? ` match “${query}”` : " yet"} — connect a website account below.
                  </p>
                ) : (
                  <form action="/api/google/oauth/connect" method="get" className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="ownerType" value="TEAM" />
                    <label htmlFor="connect-team-select" className="text-sm font-medium">
                      Team to connect
                    </label>
                    <select
                      id="connect-team-select"
                      name="ownerId"
                      required
                      className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      {teamOptions.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="rounded-lg border px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      Connect team
                    </button>
                    {totalTeams > OPTIONS_LIMIT && (
                      <span className="text-xs text-zinc-500">
                        Showing {teamOptions.length} of {totalTeams} teams — search to narrow.
                      </span>
                    )}
                  </form>
                )}
                {websiteOptions.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    No websites{query ? ` match “${query}”` : " yet"} — add one on the Websites page.
                  </p>
                ) : (
                  <form action="/api/google/oauth/connect" method="get" className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="ownerType" value="WEBSITE" />
                    <label htmlFor="connect-website-select" className="text-sm font-medium">
                      Website to connect
                    </label>
                    <select
                      id="connect-website-select"
                      name="ownerId"
                      required
                      className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      {websiteOptions.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="rounded-lg border px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      Connect website
                    </button>
                    {totalWebsites > OPTIONS_LIMIT && (
                      <span className="text-xs text-zinc-500">
                        Showing {websiteOptions.length} of {totalWebsites} websites — search to narrow.
                      </span>
                    )}
                  </form>
                )}
              </div>
            )}
          </>
        )}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Connected accounts</h2>
        {connections.length === 0 ? (
          <EmptyState
            title="No Google accounts connected"
            hint="A connection is only shown as connected after a successful authorization and validation."
          />
        ) : (
          <ul className="mt-2 space-y-4">
            {connections.map((c) => (
              <li key={c.id} className="border-b border-zinc-100 pb-4 dark:border-zinc-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{c.googleAccountEmail}</span>
                  <span className="flex items-center gap-2">
                    <ConnectionStatus status={c.status} />
                    {canManage && (
                      <>
                        <DiscoverButton connectionId={c.id} />
                        <DisconnectButton connectionId={c.id} />
                      </>
                    )}
                  </span>
                </div>
                <p className="text-xs text-zinc-500">
                  Owner: {c.ownerType} {ownerName(c)} · Scopes: {c.scopes.join(", ") || "—"} · Last success:{" "}
                  {c.lastSuccessfulAuthAt?.toISOString() ?? "never"} · Last used:{" "}
                  {c.lastUsedAt?.toISOString() ?? "never"}
                </p>
                <p className="text-xs text-zinc-500">
                  Health:{" "}
                  {c.health.length ? c.health.map((h) => `${h.provider}:${h.status}`).join(", ") : "not checked yet"}
                </p>
                {(() => {
                  const missing = providersMissingScopes(c.scopes, { adManagerEnabled: adManagerEnabled() });
                  if (missing.length === 0) return null;
                  return (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      Reconnect needed — this connection is missing required permissions for {missing.join(", ")}.{" "}
                      {canManage && (
                        <a
                          className="underline"
                          // A-GGL-20: incremental authorization — request
                          // only the missing providers' scopes instead of
                          // the full set on reconnect.
                          href={`/api/google/oauth/connect?ownerType=${c.ownerType}&ownerId=${c.ownerId}&providers=${missing.join(",")}`}
                        >
                          Reconnect now
                        </a>
                      )}
                    </p>
                  );
                })()}
                {canManage && (
                  <div className="mt-2 space-y-2">
                    {c.properties.map((p) => (
                      <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span>
                          GA4 · {p.displayName ?? p.propertyId}{" "}
                          <span className="text-xs text-zinc-500">({p.propertyId})</span>
                        </span>
                        <MapPropertyForm
                          provider="GA4"
                          externalId={p.propertyId}
                          resourceName={p.displayName ?? undefined}
                          connectionId={c.id}
                          websites={websiteOptions}
                          mappedTo={p.integrations[0]?.website.name ?? null}
                          emptyMessage={
                            query && websiteOptions.length === 0
                              ? `No websites match “${query}” — clear the search to map this property.`
                              : undefined
                          }
                        />
                      </div>
                    ))}
                    {c.searchConsoleProps.map((p) => (
                      <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span>Search Console · {p.siteUrl}</span>
                        <MapPropertyForm
                          provider="SEARCH_CONSOLE"
                          externalId={p.siteUrl}
                          connectionId={c.id}
                          websites={websiteOptions}
                          mappedTo={p.integrations[0]?.website.name ?? null}
                          emptyMessage={
                            query && websiteOptions.length === 0
                              ? `No websites match “${query}” — clear the search to map this property.`
                              : undefined
                          }
                        />
                      </div>
                    ))}
                    {c.adsenseAccounts.map((p) => (
                      <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span>
                          AdSense · {p.displayName ?? p.accountId}{" "}
                          <span className="text-xs text-zinc-500">({p.accountId})</span>
                        </span>
                        <MapPropertyForm
                          provider="ADSENSE"
                          externalId={p.accountId}
                          resourceName={p.displayName ?? undefined}
                          connectionId={c.id}
                          websites={websiteOptions}
                          mappedTo={p.integrations[0]?.website.name ?? null}
                          emptyMessage={
                            query && websiteOptions.length === 0
                              ? `No websites match “${query}” — clear the search to map this property.`
                              : undefined
                          }
                        />
                      </div>
                    ))}
                    {c.adManagerNetworks.map((p) => (
                      <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span>
                          Ad Manager (beta) · {p.displayName ?? p.networkCode}{" "}
                          <span className="text-xs text-zinc-500">({p.networkCode})</span>
                        </span>
                        <MapPropertyForm
                          provider="AD_MANAGER"
                          externalId={p.networkCode}
                          resourceName={p.displayName ?? undefined}
                          connectionId={c.id}
                          websites={websiteOptions}
                          mappedTo={p.integrations[0]?.website.name ?? null}
                          emptyMessage={
                            query && websiteOptions.length === 0
                              ? `No websites match “${query}” — clear the search to map this property.`
                              : undefined
                          }
                        />
                      </div>
                    ))}
                    {c.properties.length +
                      c.searchConsoleProps.length +
                      c.adsenseAccounts.length +
                      c.adManagerNetworks.length ===
                      0 && (
                      <p className="text-xs text-zinc-500">No properties discovered yet — use “Discover properties”.</p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {totalPages > 1 && (
          <nav aria-label="Connections pagination" className="mt-3 flex items-center justify-between text-sm">
            <span className="text-zinc-500">
              Page {page} of {totalPages} · {totalConnections} connections
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
