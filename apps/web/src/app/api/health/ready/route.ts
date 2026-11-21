import { NextResponse } from "next/server";
import { prisma } from "@metricflock/db";
import { getRedis, createLogger, errMeta } from "@metricflock/shared";

const log = createLogger("health");

// Readiness (Stage 8): can this instance actually serve traffic?
// Checks the two hard dependencies. Redis is "disabled" (not a failure)
// when REDIS_URL is unset — the app runs degraded without it by design.
export async function GET() {
  const checks: Record<string, string> = {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = "ok";
  } catch (e) {
    checks.db = "down";
    log.error("readiness: database check failed", errMeta(e));
  }
  const redis = getRedis();
  if (!redis) {
    checks.redis = "disabled";
  } else {
    try {
      const pong = await redis.ping();
      checks.redis = pong === "PONG" ? "ok" : "down";
    } catch (e) {
      checks.redis = "down";
      log.error("readiness: redis check failed", errMeta(e));
    }
  }
  const ready = checks.db === "ok" && checks.redis !== "down";
  return NextResponse.json(
    { status: ready ? "ready" : "not_ready", checks, ts: new Date().toISOString() },
    { status: ready ? 200 : 503 },
  );
}
