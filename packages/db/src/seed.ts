// Seed script.
//
// SECURITY (A-SEC-03): the seed used to create demo@example.com with the
// well-known default password "ChangeMe123!" whenever NODE_ENV was not
// exactly "production" — and the production guard keyed off NODE_ENV,
// not off the database being seeded, so a one-off seed against a remote
// DATABASE_URL with NODE_ENV unset created a known-credential SUPER_ADMIN
// in that database. Two rules now apply, enforced by checkSeedTarget
// (./seed-guard.ts) regardless of NODE_ENV:
//   1. The target database must look local (localhost / 127.0.0.1 / ::1 /
//      *.localhost) unless SEED_ALLOW_REMOTE=1 is set explicitly.
//   2. The demo admin password must come from SEED_DEMO_ADMIN_PASSWORD.
//      There is no default: without it the seed refuses to run.
// The 2026-11-23 DB survey found NO demo@example.com row in the live
// database, so no deletion was needed; this guard is what prevents one
// from ever being created there by accident.
//
// Usage: SEED_DEMO_ADMIN_PASSWORD='<private password>' pnpm db:seed
// (remote target only with SEED_ALLOW_REMOTE=1 set as well).
import { prisma } from "./client";
// better-auth's own scrypt password hash. The seed does NOT hash passwords
// itself with bcrypt: better-auth stores the credential hash in its Account
// model (providerId "credential"), and verifies it on sign-in.
import { hashPassword } from "better-auth/crypto";
import { checkSeedTarget } from "./seed-guard";

async function main() {
  const guard = checkSeedTarget({
    databaseUrl: process.env.DATABASE_URL,
    allowRemote: process.env.SEED_ALLOW_REMOTE === "1",
    password: process.env.SEED_DEMO_ADMIN_PASSWORD,
  });
  if (!guard.ok) {
    console.error(guard.reason);
    process.exit(1);
  }
  const password = guard.password;
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
        password: await hashPassword(password),
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
  console.log("Seed complete. Super admin: demo@example.com (password from SEED_DEMO_ADMIN_PASSWORD).");
}
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
