import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { Card } from "@/components/ui";
import { ApiKeyManager } from "./ApiKeyManager";

export const dynamic = "force-dynamic";

// Developer platform settings (Phase 7.5). SUPER_ADMIN only — the
// APIs enforce organization.manage regardless of this page.
export default async function ApiKeysPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");
  const keys = await prisma.apiKey.findMany({
    where: { organizationId: user.organizationId },
    select: {
      id: true,
      name: true,
      prefix: true,
      lastUsedAt: true,
      revokedAt: true,
      expiresAt: true,
      scopes: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">API keys</h1>
      <Card className="p-4">
        <h2 className="font-semibold">Public API (read-only)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          API keys give read-only access to your organization&apos;s data via <code>/api/v1/*</code> (websites,
          analytics snapshots, portfolio totals, health, insights). Send the key as{" "}
          <code>Authorization: Bearer mf_…</code>. Limit: 120 requests/minute per key. The secret is shown once when
          created — store it somewhere safe; it cannot be recovered.
        </p>
        <div className="mt-4">
          <ApiKeyManager
            initial={keys.map((k) => ({
              id: k.id,
              name: k.name,
              prefix: k.prefix,
              lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
              revokedAt: k.revokedAt?.toISOString() ?? null,
              expiresAt: k.expiresAt?.toISOString() ?? null,
              scopes: k.scopes,
              createdAt: k.createdAt.toISOString(),
            }))}
          />
        </div>
      </Card>
    </div>
  );
}
