import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth-server";
import { rateLimit } from "@metricflock/shared";
import { z } from "zod";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

function forwardCookies(from: Response, to: NextResponse) {
  from.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") to.headers.append("set-cookie", value);
  });
}

// Thin wrapper around better-auth's email sign-in so the login page's
// existing POST /api/auth/login contract is unchanged. better-auth verifies
// the scrypt password hash in its Account model and sets the session cookie.
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  const rl = rateLimit(`login:${ip}`, 10, 60_000);
  if (!rl.allowed) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const res = await auth.api.signInEmail({
    body: { email: body.data.email, password: body.data.password },
    headers: await headers(),
    asResponse: true,
  });
  if (!res.ok) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  const data = (await res.json().catch(() => null)) as { user?: { id: string; email: string; name: string; role?: string } } | null;
  const out = NextResponse.json({
    status: "ok",
    user: data?.user
      ? { id: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role }
      : undefined,
  });
  forwardCookies(res, out);
  return out;
}
