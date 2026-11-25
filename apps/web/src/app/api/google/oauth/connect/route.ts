import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/api-error";
import { requireApiAuth, assertConnectionOwnerAccess } from "@metricflock/auth";
import { buildAuthUrl, AD_MANAGER_SCOPES, type GoogleProvider } from "@metricflock/google/oauth";
import { adManagerEnabled } from "@metricflock/google/ad-manager";
import { rateLimit } from "@metricflock/shared";
import { z } from "zod";
const providerEnum = z.enum(["GA4", "SEARCH_CONSOLE", "ADSENSE", "AD_MANAGER"]);
const q = z.object({
  ownerType: z.enum(["TEAM", "WEBSITE"]),
  ownerId: z.string().min(1),
  // A-GGL-20: optional provider intent (comma-separated GoogleProvider
  // names) — incremental authorization per provider. Absent = generic
  // all-provider connect.
  providers: z.string().optional(),
});
async function get(req: NextRequest) {
  const auth = await requireApiAuth("google.connection.manage", { req });
  if ("error" in auth) return auth.error;
  // Bound connect attempts per user (OAUTH-12, Redis-backed since Stage 5),
  // fail-closed when Redis is configured but down (F-3.1).
  if (!(await rateLimit(`oauth-connect:${auth.user.id}`, 10, 60_000, { failClosed: true })).allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const parsed = q.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  // A-GGL-20: validate the provider intent before building the auth URL.
  let providers: GoogleProvider[] | undefined;
  if (parsed.data.providers !== undefined) {
    const parts = parsed.data.providers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const checked = z.array(providerEnum).safeParse(parts);
    if (!checked.success || checked.data.length === 0) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
    providers = checked.data;
  }
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
    // screen minimal for everyone else. With an explicit provider intent
    // (A-GGL-20) the Ad Manager scope comes from the intent itself
    // (REQUIRED_SCOPES_BY_PROVIDER), so it is never added on top.
    const extraScopes = providers ? [] : adManagerEnabled() ? AD_MANAGER_SCOPES : [];
    const url = await buildAuthUrl(auth.user, parsed.data.ownerType, parsed.data.ownerId, extraScopes, {
      providers,
    });
    // Browser navigation (the Integrations page links here directly):
    // send the user to Google's consent screen instead of returning
    // the URL as JSON, which rendered as raw text in the browser.
    return NextResponse.redirect(url);
  } catch {
    return NextResponse.json({ error: "google_oauth_not_configured" }, { status: 503 });
  }
}

export const GET = withApiErrors("google/oauth/connect", get);
