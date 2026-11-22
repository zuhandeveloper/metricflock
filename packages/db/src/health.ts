import { prisma } from "./client";
import type { SyncJobType } from "./client";
import { sanitizeProviderError } from "@metricflock/shared";
/** Current-state health per (websiteId, provider) — upserted, not appended
 *  (OPS-3): one row always reflects the latest check. Rows without a
 *  websiteId (connection-level) still append, since the unique key cannot
 *  match NULLs. */
export async function recordHealth(opts: {
  websiteId?: string | null;
  connectionId?: string | null;
  provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
  status: string;
  lastError?: string | null;
  success?: boolean;
}) {
  const data = {
    connectionId: opts.connectionId ?? null,
    status: opts.status,
    lastSuccessAt: opts.success ? new Date() : undefined,
    // F-6.7: provider error text is secret-redacted at the storage
    // boundary too, so no caller can persist a raw token by accident.
    lastError: opts.lastError ? sanitizeProviderError(opts.lastError) : null,
    checkedAt: new Date(),
  };
  if (opts.websiteId) {
    return prisma.integrationHealth.upsert({
      where: { websiteId_provider: { websiteId: opts.websiteId, provider: opts.provider } },
      update: data,
      create: {
        websiteId: opts.websiteId,
        provider: opts.provider,
        ...data,
        lastSuccessAt: data.lastSuccessAt ?? null,
      },
    });
  }
  return prisma.integrationHealth.create({
    data: { websiteId: null, provider: opts.provider, ...data, lastSuccessAt: data.lastSuccessAt ?? null },
  });
}
export async function lastSuccessfulSync(websiteId: string, type: SyncJobType) {
  const job = await prisma.analyticsSyncJob.findFirst({
    where: { websiteId, type, status: "SUCCEEDED" },
    orderBy: { updatedAt: "desc" },
  });
  return job?.updatedAt?.toISOString() ?? null;
}
