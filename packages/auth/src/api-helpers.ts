import { NextResponse } from "next/server";
import { getSessionUser } from "./server";
import { hasPermission, type Permission } from "./permissions";
import type { User } from "@metricflock/db";
export async function requireApiAuth(permission?: Permission): Promise<{ user: User } | { error: NextResponse }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (permission && !hasPermission(user.role, permission))
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user };
}
export function apiError(status: number, error: string, details?: unknown) {
  return NextResponse.json({ error, ...(details ? { details } : {}) }, { status });
}
