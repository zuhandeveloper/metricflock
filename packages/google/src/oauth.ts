import crypto from "node:crypto";
import { google } from "googleapis";
import { hmacState } from "@metricflock/shared";
export const GA4_SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"];
export const GSC_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];
export const ADSENSE_SCOPES = ["https://www.googleapis.com/auth/adsense.readonly"];
export const ALL_SCOPES = [...GA4_SCOPES, ...GSC_SCOPES, ...ADSENSE_SCOPES];
export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new Error("GOOGLE_OAUTH_NOT_CONFIGURED");
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}
/** Build a signed, single-use state token binding the OAuth flow to owner + user. */
export function buildState(ownerType: "TEAM" | "WEBSITE", ownerId: string, userId: string): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = JSON.stringify({ ownerType, ownerId, userId, nonce, ts: Date.now() });
  const sig = hmacState(payload);
  return Buffer.from(JSON.stringify({ payload, sig })).toString("base64url");
}
export function verifyState(
  state: string,
  maxAgeMs = 10 * 60 * 1000,
): { ownerType: "TEAM" | "WEBSITE"; ownerId: string; userId: string } {
  let parsed: { payload: string; sig: string };
  try {
    parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_STATE");
  }
  if (hmacState(parsed.payload) !== parsed.sig) throw new Error("INVALID_STATE");
  const data = JSON.parse(parsed.payload) as {
    ownerType: "TEAM" | "WEBSITE";
    ownerId: string;
    userId: string;
    ts: number;
  };
  if (Date.now() - data.ts >= maxAgeMs) throw new Error("STATE_EXPIRED");
  return data;
}
/** Fetch the Google account profile (email + id) for an authorized OAuth2 client.
 * Used by the OAuth callback right after token exchange, to identify which
 * Google account was just connected. */
export async function getGoogleAccountProfile(
  client: InstanceType<typeof google.auth.OAuth2>,
): Promise<{ email: string; id: string | null }> {
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const me = await oauth2.userinfo.get();
  return { email: me.data.email ?? "unknown@google", id: me.data.id ?? null };
}
export function buildAuthUrl(
  ownerType: "TEAM" | "WEBSITE",
  ownerId: string,
  userId: string,
  extraScopes: string[] = [],
): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // consent prompt increases the chance a refresh token is issued
    scope: [...new Set([...ALL_SCOPES, ...extraScopes])],
    state: buildState(ownerType, ownerId, userId),
    include_granted_scopes: true,
  });
}
