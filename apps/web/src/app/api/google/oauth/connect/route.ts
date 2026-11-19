import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@metricflock/auth";
import { buildAuthUrl } from "@metricflock/google/oauth";
import { z } from "zod";
const q = z.object({ ownerType: z.enum(["TEAM", "WEBSITE"]), ownerId: z.string().min(1) });
export async function GET(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.manage");
  if ("error" in auth) return auth.error;
  const parsed = q.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  try {
    const url = buildAuthUrl(parsed.data.ownerType, parsed.data.ownerId, auth.user.id);
    return NextResponse.json({ authUrl: url });
  } catch { return NextResponse.json({ error: "google_oauth_not_configured" }, { status: 503 }); }
}
