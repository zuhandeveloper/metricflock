import { Card } from "@/components/ui";
import { TwoFactorActions } from "@/app/(app)/settings/security/SecurityActions";

// A-SEC-08: blocking enrolment screen shown by the (app) layout to a
// SUPER_ADMIN who has not enabled two-factor authentication. It embeds
// the same setup component as Settings → Security, so enrolment happens
// in place — no redirect (server layouts cannot read the pathname in
// Next 16, so a redirect-to-security-page gate could not exempt the
// security page itself and would loop). After a successful verify,
// TwoFactorActions calls router.refresh(), the layout re-renders, and
// the gate lifts. The sidebar (with sign-out) is rendered by the layout
// outside this screen, so signing out remains possible.
export default function TwoFactorSetupScreen({ hasPassword }: { hasPassword: boolean }) {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-bold">Two-factor authentication required</h1>
      <Card className="p-4">
        <p className="text-sm">
          Super admins must protect their account with two-factor authentication. Set it up below to continue — you will
          need an authenticator app (Google Authenticator, Authy, 1Password…).
        </p>
        <div className="mt-4">
          <TwoFactorActions enabled={false} hasPassword={hasPassword} />
        </div>
      </Card>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        You can sign out from the sidebar at any time. This screen goes away as soon as two-factor authentication is on.
      </p>
    </div>
  );
}
