// Smoke-test fixture (Stage 7): prints the latest unexpired password-reset
// token for an email so the smoke test can complete the reset flow without
// a real mailbox (CI has no SMTP). better-auth stores the token in the
// Verification table as identifier `reset-password:{token}`, value=userId.
// Prints RESET_TOKEN=<token>. CI-only fixture; never run against prod.
import { prisma } from "../src/client";

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("usage: smoke-reset-token.ts <email>");
  const user = await prisma.user.findFirst({ where: { email } });
  if (!user) throw new Error(`user ${email} not found`);
  const row = await prisma.verification.findFirst({
    where: { value: user.id, identifier: { startsWith: "reset-password:" }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) throw new Error(`no unexpired reset token for ${email}`);
  console.log(`RESET_TOKEN=${row.identifier.slice("reset-password:".length)}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
