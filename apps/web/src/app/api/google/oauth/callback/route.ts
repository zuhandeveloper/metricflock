import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@metricflock/db";
import { verifyState, getOAuthClient, getGoogleAccountProfile } from "@metricflock/google/oauth";
import { encryptToken } from "@metricflock/shared";
import { writeAudit } from "@metricflock/db/audit";
import { invalidateOrgCache } from "@metricflock/shared";
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  if (error) return NextResponse.redirect(`${appUrl}/integrations?oauth=denied`);
  if (!code || !state) return NextResponse.redirect(`${appUrl}/integrations?oauth=invalid`);
  let data: { ownerType: "TEAM" | "WEBSITE"; ownerId: string; userId: string };
  try {
    data = verifyState(state);
  } catch {
    return NextResponse.redirect(`${appUrl}/integrations?oauth=bad_state`);
  }
  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      // Existing authorization may not return a refresh token; ask the user to
      // re-authorize with consent rather than storing an unusable connection.
      return NextResponse.redirect(`${appUrl}/integrations?oauth=no_refresh_token`);
    }
    client.setCredentials(tokens);
    const me = await getGoogleAccountProfile(client);
    const user = await prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) return NextResponse.redirect(`${appUrl}/integrations?oauth=user_not_found`);
    const email = me.email;
    await prisma.googleConnection.upsert({
      where: {
        organizationId_ownerType_ownerId_googleAccountEmail: {
          organizationId: user.organizationId,
          ownerType: data.ownerType,
          ownerId: data.ownerId,
          googleAccountEmail: email,
        },
      },
      update: {
        encryptedRefreshToken: encryptToken(tokens.refresh_token),
        encryptedAccessToken: tokens.access_token ? encryptToken(tokens.access_token) : null,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        googleAccountId: me.id,
        scopes: tokens.scope ? tokens.scope.split(" ") : [],
        status: "ACTIVE",
        lastSuccessfulAuthAt: new Date(),
        lastUsedAt: new Date(),
      },
      create: {
        organizationId: user.organizationId,
        ownerType: data.ownerType,
        ownerId: data.ownerId,
        googleAccountEmail: email,
        googleAccountId: me.id,
        encryptedRefreshToken: encryptToken(tokens.refresh_token),
        encryptedAccessToken: tokens.access_token ? encryptToken(tokens.access_token) : null,
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
      details: { ownerType: data.ownerType, ownerId: data.ownerId, googleAccountEmail: email },
    });
    await invalidateOrgCache(user.organizationId);
    return NextResponse.redirect(`${appUrl}/integrations?oauth=connected`);
  } catch {
    return NextResponse.redirect(`${appUrl}/integrations?oauth=failed`);
  }
}
