import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, getSessionUser } from "@metricflock/auth";
import { Card } from "@/components/ui";
import { SessionActions, TwoFactorActions } from "./SecurityActions";
export const dynamic = "force-dynamic";
// AUTH-11: session management + TOTP two-factor (Stage 7).
export default async function SecurityPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const reqHeaders = await headers();
  const [session, sessions] = await Promise.all([
    auth.api.getSession({ headers: reqHeaders }),
    auth.api.listSessions({ headers: reqHeaders }),
  ]);
  const rows = (sessions ?? []).map((s) => ({
    id: s.id,
    token: s.token,
    ipAddress: s.ipAddress ?? null,
    userAgent: s.userAgent ?? null,
    createdAt: new Date(s.createdAt).toISOString(),
    expiresAt: new Date(s.expiresAt).toISOString(),
    current: s.token === session?.session?.token,
  }));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Account security</h1>
      <Card className="p-4">
        <h2 className="font-semibold">Two-factor authentication</h2>
        <div className="mt-3">
          <TwoFactorActions enabled={user.twoFactorEnabled} />
        </div>
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Active sessions</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Every device signed in to your account. Revoke anything you don&apos;t recognize.
        </p>
        <div className="mt-3">
          <SessionActions sessions={rows} />
        </div>
      </Card>
    </div>
  );
}
