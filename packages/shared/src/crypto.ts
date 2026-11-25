import crypto from "node:crypto";
// AES-256-GCM authenticated encryption for OAuth tokens at rest.
//
// Envelope format (Stage 3, OAUTH-7): `v1:<keyId>:<base64(iv|tag|data)>`
// where keyId is the first 8 hex chars of SHA-256(key) — a stable,
// non-secret identifier that lets decrypt pick the right key during a
// rotation window (GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS). Ciphertexts
// without the `v1:` prefix are the legacy format (same iv|tag|data
// layout, no AAD) and still decrypt; they are re-encrypted lazily on use
// (see needsReencryption). New encryptions bind the ciphertext to an AAD
// (the connection identity) so a ciphertext cannot be transplanted
// between connection rows.
//
// Keys: base64 of exactly 32 bytes. Never log keys or tokens.
/** True when `raw` is base64 of exactly 32 bytes — the token-encryption key rule (shared by getEnv's production boot check, A-SEC-14). */
export function isEncryptionKey(raw: string | undefined): boolean {
  if (!raw) return false;
  return Buffer.from(raw, "base64").length === 32;
}
function parseKey(raw: string | undefined, envName: string): Buffer {
  if (!raw) throw new Error(`${envName} is not configured`);
  if (!isEncryptionKey(raw)) throw new Error(`${envName} must be base64 of 32 bytes`);
  return Buffer.from(raw, "base64");
}
export function getEncryptionKey(): Buffer {
  return parseKey(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY, "GOOGLE_TOKEN_ENCRYPTION_KEY");
}
function getPreviousKey(): Buffer | null {
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS;
  if (!raw) return null;
  return parseKey(raw, "GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS");
}
function keyIdOf(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}
/** AAD binding a token ciphertext to its connection's unique identity. */
export function connectionAad(parts: {
  organizationId: string;
  ownerType: string;
  ownerId: string;
  googleAccountEmail: string;
}): string {
  return `mf-conn:${parts.organizationId}:${parts.ownerType}:${parts.ownerId}:${parts.googleAccountEmail}`;
}
export function encryptToken(plaintext: string, aad = ""): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${keyIdOf(key)}:${Buffer.concat([iv, tag, enc]).toString("base64")}`;
}
function decryptWithKey(key: Buffer, buf: Buffer, aad: string | null): string {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  // authTagLength is pinned to the 16-byte tag our envelope stores, so
  // Node rejects any shorter-than-expected tag instead of verifying it
  // (Semgrep javascript.node-crypto.security.gcm-no-tag-length).
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  if (aad !== null) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
export function decryptToken(ciphertext: string, aad = ""): string {
  // Explicit envelope-version check (F-2.4): a future `v2:` (or any other
  // versioned) ciphertext must fail loudly here instead of falling into
  // the legacy branch and failing obscurely at GCM verification.
  const versionMatch = /^v(\d+):/.exec(ciphertext);
  if (versionMatch && versionMatch[1] !== "1") throw new Error("TOKEN_ENVELOPE_UNSUPPORTED");
  if (ciphertext.startsWith("v1:")) {
    const [, keyId, b64] = ciphertext.split(":");
    const current = getEncryptionKey();
    const previous = getPreviousKey();
    const key = keyIdOf(current) === keyId ? current : previous && keyIdOf(previous) === keyId ? previous : null;
    if (!key) throw new Error("TOKEN_KEY_UNKNOWN");
    return decryptWithKey(key, Buffer.from(b64, "base64"), aad);
  }
  // Legacy envelope: no key id, no AAD. Try the current key, then the
  // previous key (rows encrypted before a rotation).
  const buf = Buffer.from(ciphertext, "base64");
  try {
    return decryptWithKey(getEncryptionKey(), buf, null);
  } catch (err) {
    const previous = getPreviousKey();
    if (!previous) throw err;
    return decryptWithKey(previous, buf, null);
  }
}
/** True when a stored ciphertext should be re-encrypted with the current
 * key (legacy format, or encrypted under the previous key). */
export function needsReencryption(ciphertext: string): boolean {
  if (!ciphertext.startsWith("v1:")) return true;
  const keyId = ciphertext.split(":")[1];
  return keyId !== keyIdOf(getEncryptionKey());
}
export function hmacState(payload: string): string {
  // Fail closed: OAuth state signed with a known/guessable secret is
  // forgeable, so a missing or short SESSION_SECRET is a hard error —
  // never fall back to a default value.
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET is not configured (must be at least 32 chars)");
  }
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
/** Constant-time HMAC verification (OAUTH-3). */
export function verifyHmacState(payload: string, signature: string): boolean {
  const expected = Buffer.from(hmacState(payload), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
