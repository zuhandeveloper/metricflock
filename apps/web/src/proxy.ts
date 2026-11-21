import { NextRequest, NextResponse } from "next/server";

// Correlation IDs (Stage 8): every request carries an x-request-id —
// the caller's if they sent a sane one, otherwise a fresh UUID. Route
// handlers and the API error contract read it from the request headers,
// and it is echoed on the response so a user-reported error can be
// traced to exactly one server log line.
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export function proxy(req: NextRequest) {
  const incoming = req.headers.get("x-request-id");
  const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$).*)"],
};
