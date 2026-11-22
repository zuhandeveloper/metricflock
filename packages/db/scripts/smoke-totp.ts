// Smoke-test fixture (Stage 7): computes the current TOTP code for a
// base32 secret (RFC 6238, HMAC-SHA1, 30s step, 6 digits) so the smoke
// test can exercise the two-factor enable/verify/sign-in flow.
// Prints the code only. CI-only fixture.
import crypto from "node:crypto";

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const secret = process.argv[2];
if (!secret) {
  console.error("usage: smoke-totp.ts <base32-secret>");
  process.exit(1);
}
const counter = Math.floor(Date.now() / 30_000);
const buf = Buffer.alloc(8);
buf.writeBigUInt64BE(BigInt(counter));
const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
const offset = hmac[hmac.length - 1]! & 0x0f;
const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
console.log(code);
