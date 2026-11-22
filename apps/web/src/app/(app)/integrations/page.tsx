import { redirect } from "next/navigation";
import { getSessionUser, hasPermission } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card, EmptyState, ConnectionStatus } from "@/components/ui";
import { DisconnectButton, DiscoverButton, MapPropertyForm } from "./ConnectionActions";
export const dynamic = "force-dynamic";
export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ oauth?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const canManage = hasPermission(user.role, "google.connection.manage");
  const { oauth } = await searchParams;
  const connections = await prisma.googleConnection.findMany({
    where: { organizationId: user.organizationId },
    include: {
      health: { orderBy: { checkedAt: "desc" }, take: 3 },
      properties: { include: { integrations: { include: { website: { select: { name: true } } } } } },
      searchConsoleProps: { include: { integrations: { include: { website: { select: { name: true } } } } } },
      adsenseAccounts: { include: { integrations: { include: { website: { select: { name: true } } } } } },
      adManagerNetworks: { include: { integrations: { include: { website: { select: { name: true } } } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  const teams = await prisma.team.findMany({
    where: { organizationId: user.organizationId },
    select: { id: true, name: true },
  });
  const websites = await prisma.website.findMany({
    where: { organizationId: user.organizationId },
    select: { id: true, name: true },
  });
  const ownerName = (c: (typeof connections)[number]) =>
    c.ownerType === "TEAM"
      ? (teams.find((t) => t.id === c.ownerId)?.name ?? c.ownerId)
      : (websites.find((w) => w.id === c.ownerId)?.name ?? c.ownerId);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Integrations</h1>
      {oauth && (
        <Card className="p-3 text-sm">
          OAuth result: <strong>{oauth}</strong>
          {oauth === "no_refresh_token" &&
            " — Google did not return a refresh token. Re-authorize with the consent prompt."}
          {oauth === "connected" && " — account connected. Discover properties, then map them to websites."}
        </Card>
      )}
      <Card className="p-4">
        <h2 className="font-semibold">Connect a Google account</h2>
        <p className="text-sm text-zinc-500">
          Team-level accounts serve all websites in the team; website-level accounts take priority for that website.
        </p>
        {teams.length === 0 && websites.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">
            Create a team first (Teams page), then add a website — connections attach to a team or a website.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {teams.map((t) => (
              <a
                key={t.id}
                href={`/api/google/oauth/connect?ownerType=TEAM&ownerId=${t.id}`}
                className="rounded-lg border px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Connect team: {t.name}
              </a>
            ))}
            {websites.map((w) => (
              <a
                key={w.id}
                href={`/api/google/oauth/connect?ownerType=WEBSITE&ownerId=${w.id}`}
                className="rounded-lg border px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Connect website: {w.name}
              </a>
            ))}
          </div>
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
                          websites={websites}
                          mappedTo={p.integrations[0]?.website.name ?? null}
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
                          websites={websites}
                          mappedTo={p.integrations[0]?.website.name ?? null}
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
                          websites={websites}
                          mappedTo={p.integrations[0]?.website.name ?? null}
                        />
                      </div>
                    ))}
                    {c.adManagerNetworks.map((p) => (
                      <div key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span>
                          Ad Manager · {p.displayName ?? p.networkCode}{" "}
                          <span className="text-xs text-zinc-500">({p.networkCode})</span>
                        </span>
                        <MapPropertyForm
                          provider="AD_MANAGER"
                          externalId={p.networkCode}
                          resourceName={p.displayName ?? undefined}
                          connectionId={c.id}
                          websites={websites}
                          mappedTo={p.integrations[0]?.website.name ?? null}
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
      </Card>
    </div>
  );
}
