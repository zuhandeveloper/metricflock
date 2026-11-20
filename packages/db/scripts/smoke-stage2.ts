// Smoke-test fixture (Stage 2): a TEAM_ADMIN who administers only team-a,
// plus GoogleConnection rows (dummy tokens — never decrypted in these
// checks; disconnect's revoke is best-effort) and two discovered GA4
// properties under team-a's connection. Lets the smoke test prove
// connection visibility scoping, mapping FK persistence, and the
// single-primary rule against a real database. Idempotent. CI-only
// fixture; never run against production data.
//
// Prints KEY=value lines the smoke script captures:
//   ADMIN_USER_ID, TEAMADMIN_USER_ID, CONN_A_ID, CONN_B_ID
import { prisma } from "../src/client";
import { hashPassword } from "better-auth/crypto";

const TEAMADMIN_EMAIL = "teamadmin@example.com";
const TEAMADMIN_PASSWORD = "TeamAdmin123!";

async function upsertCredentialUser(
  email: string,
  password: string,
  data: Parameters<typeof prisma.user.create>[0]["data"],
) {
  const user = await prisma.user.upsert({ where: { email }, update: {}, create: data });
  const existing = await prisma.account.findFirst({ where: { userId: user.id, providerId: "credential" } });
  if (!existing) {
    await prisma.account.create({
      data: { accountId: user.id, providerId: "credential", userId: user.id, password: await hashPassword(password) },
    });
  }
  return user;
}

async function main() {
  const org = await prisma.organization.findFirst({ where: { slug: "main-org" } });
  if (!org) throw new Error('Seed org "main-org" not found. Run `pnpm db:seed` first.');
  const admin = await prisma.user.findFirst({ where: { email: "demo@example.com" } });
  if (!admin) throw new Error("Seed admin demo@example.com not found.");
  const teamA = await prisma.team.findFirst({ where: { organizationId: org.id, slug: "team-a" } });
  const teamB = await prisma.team.findFirst({ where: { organizationId: org.id, slug: "team-b" } });
  if (!teamA || !teamB) throw new Error("Seed teams team-a/team-b not found.");

  const teamAdmin = await upsertCredentialUser(TEAMADMIN_EMAIL, TEAMADMIN_PASSWORD, {
    organizationId: org.id,
    email: TEAMADMIN_EMAIL,
    name: "Smoke Team Admin",
    emailVerified: true,
    role: "TEAM_ADMIN",
  });
  await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: teamA.id, userId: teamAdmin.id } },
    update: { isAdmin: true },
    create: { teamId: teamA.id, userId: teamAdmin.id, isAdmin: true },
  });

  async function upsertConnection(teamId: string, email: string) {
    return prisma.googleConnection.upsert({
      where: {
        organizationId_ownerType_ownerId_googleAccountEmail: {
          organizationId: org!.id,
          ownerType: "TEAM",
          ownerId: teamId,
          googleAccountEmail: email,
        },
      },
      update: { status: "ACTIVE", teamId, websiteId: null },
      create: {
        organizationId: org!.id,
        ownerType: "TEAM",
        ownerId: teamId,
        teamId,
        googleAccountEmail: email,
        encryptedRefreshToken: "smoke-dummy-token",
        scopes: [],
        status: "ACTIVE",
        createdById: admin!.id,
      },
    });
  }
  const connA = await upsertConnection(teamA.id, "ga-a@example.com");
  const connB = await upsertConnection(teamB.id, "ga-b@example.com");

  for (const propertyId of ["properties/123456789", "properties/987654321"]) {
    await prisma.googleProperty.upsert({
      where: { connectionId_propertyId: { connectionId: connA.id, propertyId } },
      update: {},
      create: { connectionId: connA.id, propertyId, displayName: `Smoke ${propertyId}` },
    });
  }

  console.log(`ADMIN_USER_ID=${admin.id}`);
  console.log(`TEAMADMIN_USER_ID=${teamAdmin.id}`);
  console.log(`CONN_A_ID=${connA.id}`);
  console.log(`CONN_B_ID=${connB.id}`);
  console.log("Stage 2 smoke fixture ready.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
