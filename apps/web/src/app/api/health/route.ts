import { NextResponse } from "next/server";

// Liveness (Stage 8): the process is up and serving. No dependency
// checks — a liveness probe must not fail because the DB is briefly
// unreachable (that is what readiness is for).
export async function GET() {
  return NextResponse.json({ status: "ok", ts: new Date().toISOString() });
}
