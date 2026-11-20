"use client";
import { useState } from "react";
import { signIn } from "@metricflock/auth/client";
import { Card, Input, Button } from "@/components/ui";
export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function google() {
    setError(""); setBusy(true);
    const res = await signIn.social({ provider: "google", callbackURL: "/dashboard" });
    if (res?.error) { setBusy(false); setError("Google sign-in is not available right now. Use email instead."); }
    // On success better-auth redirects the browser to Google's consent screen.
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(""); setBusy(true);
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (res.ok) window.location.assign("/dashboard");
    else { setBusy(false); setError("Invalid email or password."); }
  }
  return (
    <Card className="p-6">
      <Button type="button" variant="outline" className="w-full justify-center" onClick={google}>Continue with Google</Button>
      <div className="my-4 flex items-center gap-3 text-xs text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />or continue with email<span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <form onSubmit={submit} className="space-y-3">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required autoComplete="email" />
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" required autoComplete="current-password" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" className="w-full justify-center">{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
    </Card>
  );
}
