// Smoke-test helper: creates the TEAM_MEMBER user the smoke test uses to
// prove the transfer endpoint returns 403 for a role without the
// `website.transfer` permission. Mirrors the seed's credential-account
// pattern (better-auth scrypt hash in the Account model). Idempotent —
// safe to run on every CI run.
import { prisma } from "../src/client";
import { hashPassword } from "better-auth/crypto";

const EMAIL = "member@example.com";
const PASSWORD = "SmokeMember123!";

async function main() {
  const org = await prisma.organization.findFirst({ where: { slug: "main-org" } });
  if (!org) throw new Error('Seed org "main-org" not found. Run `pnpm db:seed` first.');
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: {
      organizationId: org.id,
      email: EMAIL,
      name: "Smoke Member",
      emailVerified: true,
      role: "TEAM_MEMBER",
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
  console.log(`Smoke member ready: ${EMAIL} (TEAM_MEMBER, no website.transfer permission).`);
  console.log(`MEMBER_USER_ID=${user.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
