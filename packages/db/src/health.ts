import { prisma } from "./client";
import type { SyncJobType } from "./client";
import { sanitizeProviderError } from "@metricflock/shared";
/** Current-state health per (websiteId, provider) — upserted, not appended
 *  (OPS-3): one row always reflects the latest check. A-DB-13: a call
 *  with no websiteId writes nothing and returns null. The
 *  @@unique([websiteId, provider]) cannot match NULLs, so the old code
 *  appended a new row on every connection-level call — and no consumer
 *  can read those rows back (the alerting wrapper, the report and the
 *  health dashboard all scope by website), so they only ever
 *  accumulated. Pre-existing NULL-website rows are pruned by the
 *  scheduler tick. */
export async function recordHealth(opts: {
  websiteId?: string | null;
  connectionId?: string | null;
  provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
  status: string;
  lastError?: string | null;
  success?: boolean;
}) {
  // A-DB-13: no websiteId, no row — see the doc comment above.
  if (!opts.websiteId) return null;
  const data = {
    connectionId: opts.connectionId ?? null,
    status: opts.status,
    lastSuccessAt: opts.success ? new Date() : undefined,
    // F-6.7: provider error text is secret-redacted at the storage
    // boundary too, so no caller can persist a raw token by accident.
    lastError: opts.lastError ? sanitizeProviderError(opts.lastError) : null,
    checkedAt: new Date(),
  };
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
export async function lastSuccessfulSync(websiteId: string, type: SyncJobType) {
  const job = await prisma.analyticsSyncJob.findFirst({
    where: { websiteId, type, status: "SUCCEEDED" },
    orderBy: { updatedAt: "desc" },
  });
  return job?.updatedAt?.toISOString() ?? null;
}
