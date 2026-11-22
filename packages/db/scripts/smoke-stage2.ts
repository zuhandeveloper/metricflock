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
    create: { teamId: teamA.id, userId: teamAdmin.id, organizationId: org.id, isAdmin: true },
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
  // Phase 1 (F-1.3): a discovered property under team-b's connection, so the
  // smoke test can prove cross-team mapping is rejected.
  await prisma.googleProperty.upsert({
    where: { connectionId_propertyId: { connectionId: connB.id, propertyId: "properties/555000111" } },
    update: {},
    create: { connectionId: connB.id, propertyId: "properties/555000111", displayName: "Smoke properties/555000111" },
  });

  // Phase 4 (F-4.1): database-level tenant-integrity constraints. Each
  // invalid insert below must be rejected by Postgres itself (composite
  // FK / CHECK), not by application code.
  async function expectFailure(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch {
      return; // rejected as required
    }
    throw new Error(`Phase 4 constraint check failed: ${label} was NOT rejected`);
  }

  const propB = await prisma.googleProperty.findFirst({
    where: { connectionId: connB.id, propertyId: "properties/555000111" },
  });
  const anyWebsite = await prisma.website.findFirst({ where: { organizationId: org.id } });
  if (!propB || !anyWebsite) throw new Error("Phase 4 checks need the team-b property and a seeded website.");

  // (a) A property of connection B cannot be mapped under connection A.
  await expectFailure("cross-connection property mapping", () =>
    prisma.websiteIntegration.create({
      data: {
        websiteId: anyWebsite.id,
        provider: "GA4",
        externalId: "phase4-cross-connection",
        googleConnectionId: connA.id,
        googlePropertyId: propB.id,
      },
    }),
  );

  // (b) A connection must have exactly one typed owner.
  await expectFailure("ownerless connection", () =>
    prisma.googleConnection.create({
      data: {
        organizationId: org.id,
        ownerType: "TEAM",
        ownerId: teamA.id,
        googleAccountEmail: "phase4-ownerless@example.com",
        encryptedRefreshToken: "smoke-dummy-token",
        scopes: [],
        status: "ACTIVE",
        createdById: admin.id,
      },
    }),
  );

  // (c)+(d) A user from another organization cannot join this org's
  // team or be assigned to this org's website.
  const org2 = await prisma.organization.upsert({
    where: { slug: "smoke-org-2" },
    update: {},
    create: { name: "Smoke Org 2", slug: "smoke-org-2" },
  });
  const outsider = await prisma.user.upsert({
    where: { email: "outsider@example.com" },
    update: { organizationId: org2.id },
    create: { organizationId: org2.id, email: "outsider@example.com", name: "Smoke Outsider", role: "TEAM_MEMBER" },
  });
  await expectFailure("cross-org team membership", () =>
    prisma.teamMember.create({
      data: { teamId: teamA.id, userId: outsider.id, organizationId: org.id },
    }),
  );
  await expectFailure("cross-org website assignment", () =>
    prisma.websiteAssignment.create({
      data: { websiteId: anyWebsite.id, userId: outsider.id, organizationId: org.id },
    }),
  );
  await prisma.organization.delete({ where: { id: org2.id } }).catch(() => undefined);
  console.log(
    "smoke ok: phase4: DB constraints reject cross-connection mapping, ownerless connection, cross-org membership/assignment",
  );

  // Phase 4 (F-4.3): a throwaway organization + verified SUPER_ADMIN
  // owner, so the smoke test can exercise org export + org deletion
  // without touching the main org. Recreated here if a previous smoke
  // run deleted it.
  const deleteOrg = await prisma.organization.upsert({
    where: { slug: "smoke-org-delete" },
    update: {},
    create: { name: "Smoke Org Delete", slug: "smoke-org-delete" },
  });
  const orgOwner = await upsertCredentialUser("orgowner@example.com", "OrgOwner123!", {
    organizationId: deleteOrg.id,
    email: "orgowner@example.com",
    name: "Smoke Org Owner",
    emailVerified: true,
    role: "SUPER_ADMIN",
  });

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
