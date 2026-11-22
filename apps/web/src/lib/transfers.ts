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

/** Lazy expiry: an open transfer past its deadline is closed on first touch. */
export async function expireIfStale<T extends { id: string; status: TransferStatus; expiresAt: Date | null }>(
  transfer: T,
): Promise<T> {
  if (OPEN_TRANSFER_STATUSES.includes(transfer.status) && transfer.expiresAt && transfer.expiresAt < new Date()) {
    const updated = await prisma.websiteTransfer.update({
      where: { id: transfer.id },
      data: { status: "EXPIRED" },
    });
    return { ...transfer, status: updated.status };
  }
  return transfer;
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
