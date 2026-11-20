import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
import LoginForm from "./LoginForm";
export const dynamic = "force-dynamic";
// Standalone auth page — no app shell. Already-signed-in users go straight
// to the dashboard.
export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/dashboard");
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/logo.png" alt="MetricFlock" width={48} height={48} className="rounded-xl" />
          <h1 className="text-xl font-bold">Sign in to MetricFlock</h1>
          <p className="text-sm text-zinc-500">Your whole website portfolio, in one dashboard.</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
