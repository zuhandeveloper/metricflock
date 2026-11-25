import Link from "next/link";
import { getSessionUser } from "@metricflock/auth";
import { prisma } from "@metricflock/db";
import { hashToken } from "@metricflock/shared";
import { Card } from "@/components/ui";
import { AcceptInviteButton } from "./AcceptInviteButton";
export const dynamic = "force-dynamic";

// Public invite landing page (standalone, no app shell). The token in
// the URL is looked up by its SHA-256 hash; the raw token is never
// stored. New users join automatically at sign-up via the auth hook;
// existing accounts accept explicitly with the button.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await prisma.organizationInvite.findFirst({
    where: { tokenHash: hashToken(token), acceptedAt: null, expiresAt: { gt: new Date() } },
    include: {
      organization: { select: { name: true } },
      invitedBy: { select: { email: true } },
    },
  });
  const user = await getSessionUser();
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/logo.svg" alt="MetricFlock" width={48} height={48} className="rounded-xl" />
          <h1 className="text-xl font-bold">Organization invite</h1>
        </div>
        <Card className="space-y-3 p-4">
          {!invite ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              This invite link is invalid, expired, or already used.
            </p>
          ) : (
            <>
              <p className="text-sm">
                <strong>{invite.invitedBy.email}</strong> invited <strong>{invite.email}</strong> to join{" "}
                <strong>{invite.organization.name}</strong> as <strong>{invite.role}</strong>.
              </p>
              {user ? (
                user.email.toLowerCase() === invite.email.toLowerCase() ? (
                  <AcceptInviteButton token={token} />
                ) : (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    You are signed in as {user.email}. Sign out and sign in with {invite.email} to accept this invite.
                  </p>
                )
              ) : (
                <div className="space-y-2 text-sm">
                  <p className="text-zinc-500 dark:text-zinc-400">
                    Sign up or sign in with <strong>{invite.email}</strong> and you will join automatically.
                  </p>
                  <Link
                    href="/login"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none dark:bg-white dark:text-zinc-900"
                  >
                    Continue to sign in
                  </Link>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
