import { prisma, Prisma } from "@metricflock/db";
export async function writeAudit(opts: { organizationId: string; actorId?: string | null; action: string; entityType?: string; entityId?: string; details?: Record<string, unknown>; ipAddress?: string }) {
  // Never pass tokens/secrets in details — callers must scrub.
  await prisma.auditLog.create({ data: { organizationId: opts.organizationId, actorId: opts.actorId ?? null, action: opts.action, entityType: opts.entityType, entityId: opts.entityId, details: (opts.details ?? undefined) as Prisma.InputJsonValue | undefined, ipAddress: opts.ipAddress } });
}
