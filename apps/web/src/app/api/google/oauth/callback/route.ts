import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@metricflock/db";
import { assertConnectionOwnerAccess, getSessionUser } from "@metricflock/auth";
import { parseState, consumeOAuthState, getOAuthClient, getGoogleAccountProfile } from "@metricflock/google/oauth";
import { encryptToken, connectionAad, rateLimit } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
import { invalidateOrgCache } from "@metricflock/shared";
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  if (error) return NextResponse.redirect(`${appUrl}/integrations?oauth=denied`);
  if (!code || !state) return NextResponse.redirect(`${appUrl}/integrations?oauth=invalid`);
  // Bound callback attempts per IP (OAUTH-12).
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await rateLimit(`oauth-callback:${ip}`, 20, 60_000)).allowed) {
    return NextResponse.redirect(`${appUrl}/integrations?oauth=rate_limited`);
  }
  let nonce: string;
  try {
    nonce = parseState(state).nonce;
  } catch {
    return NextResponse.redirect(`${appUrl}/integrations?oauth=bad_state`);
  }
  // Single-use: atomically consume the persisted state record. Replayed,
  // expired, or unknown states are rejected here (OAUTH-1). Consumption
  // happens before any other check so a leaked state is burned on first
  // use, whoever presents it.
  const flow = await consumeOAuthState(nonce);
  if (!flow) return NextResponse.redirect(`${appUrl}/integrations?oauth=bad_state`);
  // Session binding (OAUTH-2): the callback must arrive in the browser
  // session of the user who started the flow.
  const sessionUser = await getSessionUser();
  if (!sessionUser) return NextResponse.redirect(`${appUrl}/integrations?oauth=login_required`);
  if (sessionUser.id !== flow.userId) return NextResponse.redirect(`${appUrl}/integrations?oauth=session_mismatch`);
  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken({ code, codeVerifier: flow.codeVerifier });
    if (!tokens.refresh_token) {
      // Existing authorization may not return a refresh token; ask the user to
      // re-authorize with consent rather than storing an unusable connection.
      return NextResponse.redirect(`${appUrl}/integrations?oauth=no_refresh_token`);
    }
    client.setCredentials(tokens);
    const me = await getGoogleAccountProfile(client);
    const user = await prisma.user.findUnique({ where: { id: flow.userId } });
    if (!user) return NextResponse.redirect(`${appUrl}/integrations?oauth=user_not_found`);
    // Re-validate at callback time that the user still manages the owner
    // (team/website) in their own organization — membership may have been
    // revoked between connect and callback, and the state alone must
    // never be enough to bind a connection to a foreign owner.
    const owner = await assertConnectionOwnerAccess(user, flow.ownerType, flow.ownerId).catch(() => null);
    if (!owner) return NextResponse.redirect(`${appUrl}/integrations?oauth=forbidden`);
    const email = me.email;
    const aad = connectionAad({
      organizationId: user.organizationId,
      ownerType: flow.ownerType,
      ownerId: flow.ownerId,
      googleAccountEmail: email,
    });
    // Typed owner columns (Stage 2, DB-1) are written alongside the legacy
    // ownerType/ownerId so both stay in sync during the transition.
    const typedOwner =
      flow.ownerType === "TEAM" ? { teamId: flow.ownerId, websiteId: null } : { teamId: null, websiteId: flow.ownerId };
    await prisma.googleConnection.upsert({
      where: {
        organizationId_ownerType_ownerId_googleAccountEmail: {
          organizationId: user.organizationId,
          ownerType: flow.ownerType,
          ownerId: flow.ownerId,
          googleAccountEmail: email,
        },
      },
      update: {
        ...typedOwner,
        encryptedRefreshToken: encryptToken(tokens.refresh_token, aad),
        encryptedAccessToken: tokens.access_token ? encryptToken(tokens.access_token, aad) : null,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        googleAccountId: me.id,
        scopes: tokens.scope ? tokens.scope.split(" ") : [],
        status: "ACTIVE",
        lastSuccessfulAuthAt: new Date(),
        lastUsedAt: new Date(),
      },
      create: {
        organizationId: user.organizationId,
        ownerType: flow.ownerType,
        ownerId: flow.ownerId,
        ...typedOwner,
        googleAccountEmail: email,
        googleAccountId: me.id,
        encryptedRefreshToken: encryptToken(tokens.refresh_token, aad),
        encryptedAccessToken: tokens.access_token ? encryptToken(tokens.access_token, aad) : null,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        scopes: tokens.scope ? tokens.scope.split(" ") : [],
        status: "ACTIVE",
        createdById: user.id,
        lastSuccessfulAuthAt: new Date(),
        lastUsedAt: new Date(),
      },
    });
    await writeAudit({
      organizationId: user.organizationId,
      actorId: user.id,
      action: "google.connection.created",
      entityType: "GoogleConnection",
      details: { ownerType: flow.ownerType, ownerId: flow.ownerId, googleAccountEmail: email },
    });
    await invalidateOrgCache(user.organizationId);
    return NextResponse.redirect(`${appUrl}/integrations?oauth=connected`);
  } catch {
    return NextResponse.redirect(`${appUrl}/integrations?oauth=failed`);
  }
}
