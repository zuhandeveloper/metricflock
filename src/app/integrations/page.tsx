import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, EmptyState, ConnectionStatus } from "@/components/ui";
export const dynamic = "force-dynamic";
export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ oauth?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { oauth } = await searchParams;
  const connections = await prisma.googleConnection.findMany({ where: { organizationId: user.organizationId }, include: { health: { orderBy: { checkedAt: "desc" }, take: 3 } }, orderBy: { createdAt: "desc" } });
  const teams = await prisma.team.findMany({ where: { organizationId: user.organizationId }, select: { id: true, name: true } });
  const websites = await prisma.website.findMany({ where: { organizationId: user.organizationId }, select: { id: true, name: true } });
  return (
    <div className="space-y-4"><h1 className="text-2xl font-bold">Integrations</h1>
      {oauth && <Card className="p-3 text-sm">OAuth result: <strong>{oauth}</strong>{oauth === "no_refresh_token" && " — Google did not return a refresh token. Re-authorize with the consent prompt."}{oauth === "connected" && " — account connected. Discover properties, then map them to websites."}</Card>}
      <Card className="p-4"><h2 className="font-semibold">Connect a Google account</h2>
        <p className="text-sm text-zinc-500">Team-level accounts serve all websites in the team; website-level accounts take priority for that website.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {teams.map((t) => <a key={t.id} href={`/api/google/oauth/connect?ownerType=TEAM&ownerId=${t.id}`} className="rounded-lg border px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">Connect team: {t.name}</a>)}
          {websites.map((w) => <a key={w.id} href={`/api/google/oauth/connect?ownerType=WEBSITE&ownerId=${w.id}`} className="rounded-lg border px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">Connect website: {w.name}</a>)}
        </div>
      </Card>
      <Card className="p-4"><h2 className="font-semibold">Connected accounts</h2>
        {connections.length === 0 ? <EmptyState title="No Google accounts connected" hint="A connection is only shown as connected after a successful authorization and validation." /> : (
          <ul className="mt-2 space-y-3">{connections.map((c) => (
            <li key={c.id} className="border-b border-zinc-100 pb-3 dark:border-zinc-800">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{c.googleAccountEmail}</span><ConnectionStatus status={c.status} /></div>
              <p className="text-xs text-zinc-500">Owner: {c.ownerType} {c.ownerId} · Scopes: {c.scopes.join(", ") || "—"} · Last success: {c.lastSuccessfulAuthAt?.toISOString() ?? "never"} · Last used: {c.lastUsedAt?.toISOString() ?? "never"}</p>
              <p className="text-xs text-zinc-500">Health: {c.health.length ? c.health.map((h) => `${h.provider}:${h.status}`).join(", ") : "not checked yet"}</p>
            </li>))}</ul>)}
      </Card>
    </div>
  );
}
