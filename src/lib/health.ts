import { prisma } from "./prisma";
export async function recordHealth(opts: { websiteId?: string | null; connectionId?: string | null; provider: "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER"; status: string; lastError?: string | null; success?: boolean }) {
  return prisma.integrationHealth.create({
    data: { websiteId: opts.websiteId ?? null, connectionId: opts.connectionId ?? null, provider: opts.provider, status: opts.status, lastSuccessAt: opts.success ? new Date() : null, lastError: opts.lastError ?? null },
  });
}
export async function lastSuccessfulSync(websiteId: string, type: string) {
  const job = await prisma.analyticsSyncJob.findFirst({ where: { websiteId, type: type as never, status: "SUCCEEDED" }, orderBy: { updatedAt: "desc" } });
  return job?.updatedAt?.toISOString() ?? null;
}
