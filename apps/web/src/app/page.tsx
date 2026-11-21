import { redirect } from "next/navigation";
import { getSessionUser } from "@metricflock/auth";
export const dynamic = "force-dynamic";
// Signed-in users go to the dashboard; everyone else goes straight to the
// standalone login page (no / -> /dashboard -> /login bounce).
export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? "/dashboard" : "/login");
}
