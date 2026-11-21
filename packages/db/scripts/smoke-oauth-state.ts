// Smoke-test fixture (Stage 3): mints persisted OAuthState records with
// known nonces so the smoke test can exercise the callback matrix
// (expired state, wrong-session state) against a real database.
// Prints KEY=value lines the smoke script captures:
//   EXPIRED_STATE, MEMBER_STATE
// CI-only fixture; never run against production data.
import crypto from "node:crypto";
import { prisma } from "../src/client";

function signStateNonce(nonce: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be set (>= 32 chars)");
  const payload = JSON.stringify({ nonce });
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(JSON.stringify({ payload, sig })).toString("base64url");
}

async function main() {
  const admin = await prisma.user.findFirst({ where: { email: "demo@example.com" } });
  const member = await prisma.user.findFirst({ where: { email: "member@example.com" } });
  if (!admin || !member) throw new Error("Seed admin/member not found. Run `pnpm db:seed` + smoke-member first.");
  const teamA = await prisma.team.findFirst({ where: { organizationId: admin.organizationId, slug: "team-a" } });
  if (!teamA) throw new Error("Seed team-a not found.");

  async function mint(userId: string, organizationId: string, expiresAt: Date) {
    const nonce = crypto.randomBytes(32).toString("hex");
    await prisma.oAuthState.create({
      data: {
        nonceHash: crypto.createHash("sha256").update(nonce).digest("hex"),
        userId,
        organizationId,
        ownerType: "TEAM",
        ownerId: teamA!.id,
        codeVerifier: crypto.randomBytes(32).toString("base64url"),
        expiresAt,
      },
    });
    return signStateNonce(nonce);
  }

  const expiredState = await mint(admin.id, admin.organizationId, new Date(Date.now() - 60_000));
  const memberState = await mint(member.id, member.organizationId, new Date(Date.now() + 10 * 60_000));
  console.log(`EXPIRED_STATE=${expiredState}`);
  console.log(`MEMBER_STATE=${memberState}`);
  console.log("Stage 3 OAuth state fixture ready.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
