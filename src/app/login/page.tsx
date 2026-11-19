"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Input, Button } from "@/components/ui";
export default function LoginPage() {
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (res.ok) router.push("/dashboard"); else setError("Invalid credentials.");
  }
  return (
    <div className="mx-auto max-w-sm pt-16">
      <Card className="p-6">
        <h1 className="text-xl font-bold">Sign in</h1>
        <p className="mt-1 text-sm text-zinc-500">Use your organization account. Seed admin: demo@example.com (change the password after first login).</p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required />
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" required />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full justify-center">Sign in</Button>
        </form>
      </Card>
    </div>
  );
}
