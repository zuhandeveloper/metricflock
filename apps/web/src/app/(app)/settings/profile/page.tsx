import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import { Card } from "@/components/ui";
import { userHasPassword } from "@/lib/has-password";
import { TwoFactorActions } from "../security/SecurityActions";
import { ChangePasswordForm, NameForm, SetPasswordForm } from "./ProfileActions";
export const dynamic = "force-dynamic";

// Profile: name, password (set for Google-only accounts, change
// otherwise) and two-factor management in one place. Email is shown
// read-only — changing it needs a verification flow of its own.
export default async function ProfilePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const hasPassword = await userHasPassword(user.id);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Profile</h1>
      <Card className="p-4">
        <h2 className="font-semibold">Your details</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Email: <span className="text-zinc-700 dark:text-zinc-200">{user.email}</span>
        </p>
        <div className="mt-3">
          <NameForm initialName={user.name ?? ""} />
        </div>
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Password</h2>
        <div className="mt-3">{hasPassword ? <ChangePasswordForm /> : <SetPasswordForm />}</div>
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold">Two-factor authentication</h2>
        <div className="mt-3">
          <TwoFactorActions enabled={user.twoFactorEnabled} hasPassword={hasPassword} />
        </div>
      </Card>
    </div>
  );
}
