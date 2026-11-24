import { NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { destroySession } from "@metricflock/auth";

// Revokes the better-auth session and forwards its Set-Cookie header so
// the browser actually drops the session cookie.
async function post() {
  const res = await destroySession();
  const out = NextResponse.json({ status: "ok" });
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") out.headers.append("set-cookie", value);
  });
  return out;
}

export const POST = withApiErrors("auth/logout", post);
