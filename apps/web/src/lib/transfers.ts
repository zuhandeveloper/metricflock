import { apiError } from "./api-error";
import { prisma } from "@metricflock/db";
import type { TransferStatus, User } from "@metricflock/db";

// Two-sided transfer state machine (Stage 7, API-4/DB-4):
//   PENDING_ACCEPTANCE --accept--> PENDING_CONNECTION --complete--> COMPLETED
//   PENDING_ACCEPTANCE --reject--> CANCELLED
//   open states --cancel (initiator)--> CANCELLED
//   open states --expiry (7 days, lazy)--> EXPIRED
// Nothing moves until completion: teamId, assignments and integrations
// stay with the current team while a transfer is open.
export const OPEN_TRANSFER_STATUSES: TransferStatus[] = ["INITIATED", "PENDING_ACCEPTANCE", "PENDING_CONNECTION"];
export const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function loadTransferInOrg(id: string, organizationId: string) {
  return prisma.websiteTransfer.findFirst({
    where: { id, website: { organizationId } },
    include: { website: { select: { id: true, name: true, domain: true, teamId: true, organizationId: true } } },
  });
}

/** Lazy expiry: an open transfer past its deadline is closed on first touch.
 *  A-DB-01: the flip is a guarded updateMany on the open statuses, so a
 *  concurrent transition wins instead of being overwritten with EXPIRED;
 *  when the guard matches 0 rows the caller's view is refreshed from the
 *  winning state. */
export async function expireIfStale<T extends { id: string; status: TransferStatus; expiresAt: Date | null }>(
  transfer: T,
): Promise<T> {
  if (OPEN_TRANSFER_STATUSES.includes(transfer.status) && transfer.expiresAt && transfer.expiresAt < new Date()) {
    const result = await prisma.websiteTransfer.updateMany({
      where: { id: transfer.id, status: { in: OPEN_TRANSFER_STATUSES } },
      data: { status: "EXPIRED" },
    });
    if (result.count === 0) {
      const current = await prisma.websiteTransfer.findUnique({
        where: { id: transfer.id },
        select: { status: true },
      });
      return { ...transfer, status: (current?.status ?? transfer.status) as T["status"] };
    }
    return { ...transfer, status: "EXPIRED" as T["status"] };
  }
  return transfer;
}

/** 409 for a transfer whose status changed under the caller (a guarded
 *  updateMany matched 0 rows). Mirrors the sequential invalid-state
 *  contract, including the EXPIRED case, so a race loser gets the same
 *  stable error a sequential caller would. */
export function transferStaleStateResponse(status: TransferStatus) {
  // A-API-11: the observed status is client-actionable detail, so it
  // lives in `details` — the error envelope is `{ error, requestId }`
  // plus `details` only. No request in scope here; apiError mints the id
  // and the `withApiErrors` wrapper preserves it.
  if (status === "EXPIRED") return apiError("transfer_expired", 409);
  return apiError("invalid_state", 409, { status });
}

/** Destination-side authority: SUPER_ADMIN, or an isAdmin member of the
 *  destination team. */
export async function canActForDestination(user: User, toTeamId: string): Promise<boolean> {
  if (user.role === "SUPER_ADMIN") return true;
  const membership = await prisma.teamMember.findFirst({
    where: { teamId: toTeamId, userId: user.id, isAdmin: true },
  });
  return Boolean(membership);
}
