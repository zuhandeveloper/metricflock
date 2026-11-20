import { prisma } from "./client";
import type { SyncJobType } from "./client";
export async function recordHealth(opts: {
  websiteId?: string | null;
  connectionId?: string | null;
  provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
  status: string;
  lastError?: string | null;
  success?: boolean;
}) {
  return prisma.integrationHealth.create({
    data: {
      websiteId: opts.websiteId ?? null,
      connectionId: opts.connectionId ?? null,
      provider: opts.provider,
      status: opts.status,
      lastSuccessAt: opts.success ? new Date() : null,
      lastError: opts.lastError ?? null,
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
