import { prisma, Prisma } from "./client";
import { createLogger, errMeta, redactSecrets, clientIpFromHeaders } from "@metricflock/shared";

const log = createLogger("db/audit");

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

export type WriteAuditOptions = {
  organizationId: string;
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  requestId?: string;
};

/** A-SEC-16: `ipAddress` must never store a raw forwarded chain. Callers
 *  already pass `clientIpFromHeaders(...)` (A-SEC-05) and better-auth
 *  session IPs come pre-collapsed — but this is the single choke point,
 *  so normalize here too: the stored value is the trusted client IP per
 *  the A-SEC-05 rule, never the attacker-controlled header. Reuses the
 *  A-SEC-05 helper verbatim by feeding the stored value back as a
 *  synthetic `x-forwarded-for` header — trusted proxy → first entry of
 *  the chain; untrusted → "unknown". The `x-real-ip` preference of that
 *  rule lives at the sources (routes pass real headers; better-auth is
 *  configured with the same order in `packages/auth/src/server.ts`) —
 *  a bare stored string cannot recover it. Idempotent for values the
 *  routes already normalized ("unknown" stays "unknown", a single IP
 *  passes through). `undefined` stays `undefined` (rows without an IP).
 *
 *  NOTE: this file also carries A-DB-09's transaction parameter — this
 *  change is additive only (one helper + one line in the data object);
 *  the `tx` behaviour is untouched. */
export function normalizeAuditIp(ipAddress: string | undefined): string | undefined {
  if (!ipAddress) return undefined;
  return clientIpFromHeaders({
    get: (name: string) => (name === "x-forwarded-for" ? ipAddress : null),
  });
}

/** A-DB-09: the audit row must be atomic with the mutation it records.
 *  Pass the caller's transaction client (`tx`) and the row is written
 *  inside that transaction — it commits or rolls back with the mutation,
 *  so the trail can neither lie about a committed action nor lose a
 *  record to a crash between the mutation and the audit write. Errors
 *  then propagate: the transaction rolls back and the API reports
 *  failure for a mutation that did not commit (truthful, retryable).
 *
 *  Without `tx` the write is best-effort: a failure is logged (with the
 *  action/entity so the gap is detectable) and never thrown, so an audit
 *  failure can never turn a successful mutation into a 500. This is also
 *  what the pre-existing `.catch(() => undefined)` at the call sites
 *  does — the two layers are redundant on purpose, not a contradiction:
 *  the call-site catch covers a route whose audit runs after its
 *  mutation, and this catch covers the three call sites that never had
 *  one (OAuth callback, member invite, auth server).
 */
export async function writeAudit(opts: WriteAuditOptions, tx?: Prisma.TransactionClient) {
  const data = {
    organizationId: opts.organizationId,
    actorId: opts.actorId ?? null,
    action: opts.action,
    entityType: opts.entityType,
    entityId: opts.entityId,
    details: (opts.details ? scrubAuditDetails(opts.details) : undefined) as Prisma.InputJsonValue | undefined,
    ipAddress: normalizeAuditIp(opts.ipAddress),
    requestId: opts.requestId,
  };
  if (tx) {
    await tx.auditLog.create({ data });
    return;
  }
  try {
    await prisma.auditLog.create({ data });
  } catch (e) {
    log.error("audit.write_failed", {
      action: opts.action,
      entityType: opts.entityType,
      entityId: opts.entityId,
      ...errMeta(e),
    });
  }
}
