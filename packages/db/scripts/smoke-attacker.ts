// Smoke-test helper: creates a SECOND organization with its own SUPER_ADMIN
// so the smoke test can prove cross-tenant attacks fail (foreign teamId on
// website create, foreign OAuth owner). Mirrors the seed's credential-account
// pattern (better-auth scrypt hash in the Account model). Idempotent — safe
// to run on every CI run. CI-only fixture; never run against production data.
import { prisma } from "../src/client";
import { hashPassword } from "better-auth/crypto";

const EMAIL = "attacker-admin@example.com";
const PASSWORD = "AttackerAdmin123!";

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "attacker-org" },
    update: {},
    create: { name: "Attacker Organization (smoke fixture)", slug: "attacker-org" },
  });
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: {
      organizationId: org.id,
      email: EMAIL,
      name: "Attacker Admin",
      emailVerified: true,
      role: "SUPER_ADMIN",
    },
  });
  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
  });
  if (!existingAccount) {
    await prisma.account.create({
      data: {
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: await hashPassword(PASSWORD),
      },
    });
  }
  console.log(`Attacker fixture ready: ${EMAIL} (SUPER_ADMIN of attacker-org).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
