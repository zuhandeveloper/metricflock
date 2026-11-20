import { prisma } from "./client";
// better-auth's own scrypt password hash. The seed does NOT hash passwords
// itself with bcrypt: better-auth stores the credential hash in its Account
// model (providerId "credential"), and verifies it on sign-in.
import { hashPassword } from "better-auth/crypto";

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "main-org" },
    update: {},
    create: { name: "Main Organization", slug: "main-org" },
  });
  const user = await prisma.user.upsert({
    where: { email: "demo@example.com" },
    update: {},
    create: {
      organizationId: org.id,
      email: "demo@example.com",
      name: "Super Admin",
      emailVerified: true,
      role: "SUPER_ADMIN",
    },
  });
  // Credential account for the demo admin (idempotent: only created once).
  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
  });
  if (!existingAccount) {
    await prisma.account.create({
      data: {
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: await hashPassword("ChangeMe123!"),
      },
    });
  }
  const teamA = await prisma.team.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: "team-a" } },
    update: {},
    create: { organizationId: org.id, name: "Team A", slug: "team-a" },
  });
  const teamB = await prisma.team.upsert({
    where: { organizationId_slug: { organizationId: org.id, slug: "team-b" } },
    update: {},
    create: { organizationId: org.id, name: "Team B", slug: "team-b" },
  });
  const sites = [
    {
      name: "Cottage Food HQ (example)",
      domain: "cottagefood.example.com",
      url: "https://cottagefood.example.com",
      description: "Seed example site — cottage food laws by state.",
    },
    {
      name: "EV Charger Guide (example)",
      domain: "evcharger.example.com",
      url: "https://evcharger.example.com",
      description: "Seed example site — EV home charger installation costs.",
    },
    {
      name: "Home Kitchen Law (example)",
      domain: "homekitchenlaw.example.com",
      url: "https://homekitchenlaw.example.com",
      description: "Seed example site — home kitchen business law.",
    },
  ];
  for (const [i, s] of sites.entries()) {
    await prisma.website.upsert({
      where: { organizationId_domain: { organizationId: org.id, domain: s.domain } },
      update: {},
      create: { ...s, organizationId: org.id, teamId: i < 2 ? teamA.id : teamB.id, status: "PENDING_SETUP" },
    });
  }
  console.log("Seed complete. Super admin: demo@example.com / ChangeMe123! — CHANGE THIS PASSWORD.");
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
