import crypto from "node:crypto";
import { google } from "googleapis";
import { CodeChallengeMethod } from "google-auth-library";
import { prisma } from "@metricflock/db";
import { hmacState, verifyHmacState, hashToken } from "@metricflock/shared";
export const GA4_SCOPES = ["https://www.googleapis.com/auth/analytics.readonly"];
export const GSC_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];
export const ADSENSE_SCOPES = ["https://www.googleapis.com/auth/adsense.readonly"];
export const AD_MANAGER_SCOPES = ["https://www.googleapis.com/auth/admanager.readonly"];
// Identity scopes: getGoogleAccountProfile() calls oauth2 userinfo, which
// requires an identity scope. Without these the callback only worked when
// the same Google account had previously granted identity scopes via
// better-auth Google sign-in (F-2.1a).
export const IDENTITY_SCOPES = ["openid", "email"];
export const ALL_SCOPES = [...IDENTITY_SCOPES, ...GA4_SCOPES, ...GSC_SCOPES, ...ADSENSE_SCOPES];
export type GoogleProvider = "GA4" | "SEARCH_CONSOLE" | "ADSENSE" | "AD_MANAGER";
export const REQUIRED_SCOPES_BY_PROVIDER: Record<GoogleProvider, string[]> = {
  GA4: GA4_SCOPES,
  SEARCH_CONSOLE: GSC_SCOPES,
  ADSENSE: ADSENSE_SCOPES,
  AD_MANAGER: AD_MANAGER_SCOPES,
};
/** Required scopes for `provider` that are absent from a connection's
 * granted scope list (F-2.1c). Empty array = fully authorized. */
export function missingScopesForProvider(granted: string[], provider: GoogleProvider): string[] {
  const have = new Set(granted);
  return REQUIRED_SCOPES_BY_PROVIDER[provider].filter((s) => !have.has(s));
}
/** Providers whose required scopes are missing from `granted` — the
 * connection needs reauthorization for those providers (F-2.1d). Ad
 * Manager is only required when the feature is enabled. */
export function providersMissingScopes(granted: string[], opts: { adManagerEnabled: boolean }): GoogleProvider[] {
  const providers: GoogleProvider[] = ["GA4", "SEARCH_CONSOLE", "ADSENSE"];
  if (opts.adManagerEnabled) providers.push("AD_MANAGER");
  return providers.filter((p) => missingScopesForProvider(granted, p).length > 0);
}
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new Error("GOOGLE_OAUTH_NOT_CONFIGURED");
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}
/** PKCE pair (S256). The verifier is stored server-side with the state
 * record and presented at token exchange; only the challenge travels in
 * the authorization URL. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
/** Signs a state nonce into the opaque `state` parameter value. The
 * signature gives integrity (forged states fail before any DB lookup);
 * single-use and session binding come from the persisted record. */
export function signStateNonce(nonce: string): string {
  const payload = JSON.stringify({ nonce });
  return Buffer.from(JSON.stringify({ payload, sig: hmacState(payload) })).toString("base64url");
}
/** Verifies the state signature (constant-time) and returns the nonce.
 * Throws INVALID_STATE on any malformation or signature mismatch. */
export function parseState(state: string): { nonce: string } {
  let parsed: { payload: string; sig: string };
  try {
    parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_STATE");
  }
  if (typeof parsed.payload !== "string" || typeof parsed.sig !== "string") throw new Error("INVALID_STATE");
  if (!verifyHmacState(parsed.payload, parsed.sig)) throw new Error("INVALID_STATE");
  let data: { nonce?: unknown };
  try {
    data = JSON.parse(parsed.payload);
  } catch {
    throw new Error("INVALID_STATE");
  }
  if (typeof data.nonce !== "string" || data.nonce.length === 0) throw new Error("INVALID_STATE");
  return { nonce: data.nonce };
}
export type OAuthFlowRecord = {
  id: string;
  userId: string;
  organizationId: string;
  ownerType: "TEAM" | "WEBSITE";
  ownerId: string;
  codeVerifier: string;
};
/** Starts a connect flow: persists a single-use state record (nonce hash,
 * initiating user/org, target owner, PKCE verifier, 10-minute expiry)
 * and returns the signed state parameter + PKCE challenge. */
export async function createOAuthFlow(input: {
  userId: string;
  organizationId: string;
  ownerType: "TEAM" | "WEBSITE";
  ownerId: string;
}): Promise<{ state: string; codeChallenge: string }> {
  const nonce = crypto.randomBytes(32).toString("hex");
  const { verifier, challenge } = createPkcePair();
  // Opportunistic cleanup keeps the table tiny (rows live 10 minutes).
  await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  await prisma.oAuthState.create({
    data: {
      nonceHash: hashToken(nonce),
      userId: input.userId,
      organizationId: input.organizationId,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      codeVerifier: verifier,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    },
  });
  return { state: signStateNonce(nonce), codeChallenge: challenge };
}
/** Atomically consumes a state record: exactly one callback can win.
 * Returns null for unknown, expired, or already-consumed nonces. */
export async function consumeOAuthState(nonce: string): Promise<OAuthFlowRecord | null> {
  const nonceHash = hashToken(nonce);
  const now = new Date();
  const consumed = await prisma.oAuthState.updateMany({
    where: { nonceHash, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) return null;
  const record = await prisma.oAuthState.findUnique({ where: { nonceHash } });
  if (!record) return null;
  return {
    id: record.id,
    userId: record.userId,
    organizationId: record.organizationId,
    ownerType: record.ownerType,
    ownerId: record.ownerId,
    codeVerifier: record.codeVerifier,
  };
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
export async function buildAuthUrl(
  user: { id: string; organizationId: string },
  ownerType: "TEAM" | "WEBSITE",
  ownerId: string,
  extraScopes: string[] = [],
): Promise<string> {
  const client = getOAuthClient();
  const { state, codeChallenge } = await createOAuthFlow({
    userId: user.id,
    organizationId: user.organizationId,
    ownerType,
    ownerId,
  });
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // consent prompt increases the chance a refresh token is issued
    scope: [...new Set([...ALL_SCOPES, ...extraScopes])],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    include_granted_scopes: true,
  });
}
