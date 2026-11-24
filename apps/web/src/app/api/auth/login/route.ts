import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { auth } from "@metricflock/auth";
import { rateLimit, clientIpFromHeaders } from "@metricflock/shared";
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
async function post(req: NextRequest) {
  // Trusted client IP (never the raw XFF header) + fail-closed when Redis
  // is configured but down (F-3.1): login throttling must not silently
  // degrade to per-instance buckets.
  const ip = clientIpFromHeaders(req.headers);
  const rl = await rateLimit(`login:${ip}`, 10, 60_000, { failClosed: true });
  if (!rl.allowed) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const body = schema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const res = await auth.api.signInEmail({
    body: { email: body.data.email, password: body.data.password },
    headers: await headers(),
    asResponse: true,
  });
  if (!res.ok) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  const data = (await res.json().catch(() => null)) as {
    user?: { id: string; email: string; name: string; role?: string };
    twoFactorRedirect?: boolean;
  } | null;
  // 2FA: better-auth returns twoFactorRedirect (and sets the pending-2FA
  // cookie) instead of a session. The login form then collects the TOTP
  // code and posts it to /api/auth/two-factor/verify-totp.
  if (data?.twoFactorRedirect) {
    const out = NextResponse.json({ status: "two_factor_required" });
    forwardCookies(res, out);
    return out;
  }
  const out = NextResponse.json({
    status: "ok",
    user: data?.user
      ? { id: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role }
      : undefined,
  });
  forwardCookies(res, out);
  return out;
}

export const POST = withApiErrors("auth/login", post);
