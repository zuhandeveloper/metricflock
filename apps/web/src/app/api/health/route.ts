import { NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";

// Liveness (Stage 8): the process is up and serving. No dependency
// checks — a liveness probe must not fail because the DB is briefly
// unreachable (that is what readiness is for).
async function get() {
  return NextResponse.json({ status: "ok", ts: new Date().toISOString() });
}

export const GET = withApiErrors("health", get);
