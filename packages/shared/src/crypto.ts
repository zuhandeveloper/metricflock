import crypto from "node:crypto";
// AES-256-GCM authenticated encryption for OAuth tokens at rest.
// Key: base64 of exactly 32 bytes, from GOOGLE_TOKEN_ENCRYPTION_KEY. Never log keys or tokens.
export function getEncryptionKey(): Buffer {
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY must be base64 of 32 bytes");
  return key;
}
export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}
export function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
export function hmacState(payload: string): string {
  const secret = process.env.SESSION_SECRET ?? "missing-session-secret";
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
