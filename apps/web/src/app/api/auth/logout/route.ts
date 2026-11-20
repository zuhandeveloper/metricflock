import { NextResponse } from "next/server";
import { destroySession } from "@metricflock/auth";

// Revokes the better-auth session and forwards its Set-Cookie header so
// the browser actually drops the session cookie.
export async function POST() {
  const res = await destroySession();
  const out = NextResponse.json({ status: "ok" });
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") out.headers.append("set-cookie", value);
  });
  return out;
}
