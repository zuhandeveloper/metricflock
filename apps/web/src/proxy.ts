import { NextRequest, NextResponse } from "next/server";

// Correlation IDs (Stage 8): every request carries an x-request-id —
// the caller's if they sent a sane one, otherwise a fresh UUID. Route
// handlers and the API error contract read it from the request headers,
// and it is echoed on the response so a user-reported error can be
// traced to exactly one server log line.
//
// Nonce-based CSP (Phase 6, F-6.8): script-src no longer allows
// 'unsafe-inline'. Each request gets a fresh nonce; Next applies it
// to the framework scripts/styles it injects (the root layout reads
// x-nonce, which also opts pages into dynamic rendering so the nonce
// is present in the HTML). 'strict-dynamic' lets those trusted
// scripts load the app chunks. style-src keeps 'unsafe-inline' —
// inline style ATTRIBUTES (charts) cannot carry nonces. img-src is
// narrowed from https: to self/data: (no remote images are rendered).
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const isDev = process.env.NODE_ENV !== "production";

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function proxy(req: NextRequest) {
  const incoming = req.headers.get("x-request-id");
  const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-nonce", nonce);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  res.headers.set("Content-Security-Policy", buildCsp(nonce));
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$).*)"],
};
