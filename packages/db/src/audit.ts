import { prisma, Prisma } from "./client";
import { redactSecrets } from "@metricflock/shared";

const SENSITIVE_KEY = /token|secret|password|credential|api[-_]?key|authorization/i;

/** DB-10: scrubbing is enforced here, not left to callers. Any detail key
 *  that looks like a credential is dropped (recursively) before storage. */
// Phase 6 (F-6.7): string values are secret-redacted too (see redact.ts).
export function scrubAuditDetails(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(scrubAuditDetails);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = scrubAuditDetails(v);
    }
    return out;
  }
  return value;
}

export async function writeAudit(opts: {
  organizationId: string;
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  requestId?: string;
}) {
  await prisma.auditLog.create({
    data: {
      organizationId: opts.organizationId,
      actorId: opts.actorId ?? null,
      action: opts.action,
      entityType: opts.entityType,
      entityId: opts.entityId,
      details: (opts.details ? scrubAuditDetails(opts.details) : undefined) as Prisma.InputJsonValue | undefined,
      ipAddress: opts.ipAddress,
      requestId: opts.requestId,
    },
  });
}
