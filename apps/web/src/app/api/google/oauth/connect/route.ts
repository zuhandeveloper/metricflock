import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth, assertConnectionOwnerAccess } from "@metricflock/auth";
import { buildAuthUrl, AD_MANAGER_SCOPES } from "@metricflock/google/oauth";
import { adManagerEnabled } from "@metricflock/google/ad-manager";
import { rateLimit } from "@metricflock/shared";
import { z } from "zod";
const q = z.object({ ownerType: z.enum(["TEAM", "WEBSITE"]), ownerId: z.string().min(1) });
export async function GET(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.manage");
  if ("error" in auth) return auth.error;
  // Bound connect attempts per user (OAUTH-12, Redis-backed since Stage 5),
  // fail-closed when Redis is configured but down (F-3.1).
  if (!(await rateLimit(`oauth-connect:${auth.user.id}`, 10, 60_000, { failClosed: true })).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const parsed = q.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  // The owner (team/website) must belong to the caller's organization and
  // the caller must manage it. Without this, a user could bind a Google
  // connection to another organization's team/website (cross-tenant
  // connection injection). Checked BEFORE building the auth URL so the
  // response does not depend on Google configuration.
  const owner = await assertConnectionOwnerAccess(auth.user, parsed.data.ownerType, parsed.data.ownerId).catch(
    () => null,
  );
  if (!owner) return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
  try {
    // Ad Manager's readonly scope is requested only when the feature is
    // enabled (F-2.1b) — incremental authorization keeps the base consent
    // screen minimal for everyone else.
    const extraScopes = adManagerEnabled() ? AD_MANAGER_SCOPES : [];
    const url = await buildAuthUrl(auth.user, parsed.data.ownerType, parsed.data.ownerId, extraScopes);
    // Browser navigation (the Integrations page links here directly):
    // send the user to Google's consent screen instead of returning
    // the URL as JSON, which rendered as raw text in the browser.
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.json({ error: "google_oauth_not_configured" }, { status: 503 });
  }
}
