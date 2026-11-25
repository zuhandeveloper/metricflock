// Smoke-test fixture (A-DB-08): verifies the `GoogleConnection`
// legacy-owner CHECK — the legacy polymorphic columns must name exactly
// the typed owner FK. Divergent rows (the audit's reproduction: a direct
// UPDATE moving teamId while ownerType/ownerId still name the old owner)
// must be rejected by Postgres with a CHECK violation naming the
// constraint, and an in-sync row must insert fine. CI-only fixture:
// creates a scratch org, asserts, then deletes it (cascade).
import { prisma } from "../src/client";

const CHECK = "GoogleConnection_legacy_owner_match_check";

async function expectCheckFailure(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    if (String(e).includes(CHECK)) return;
    throw new Error(`A-DB-08 check failed: ${label} was rejected, but not by ${CHECK}: ${String(e)}`);
  }
  throw new Error(`A-DB-08 check failed: ${label} was NOT rejected`);
}

async function main() {
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: "DB-08", slug: `db08-${stamp}` } });
  try {
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        name: "DB-08 User",
        email: `db08-${stamp}@example.com`,
        role: "SUPER_ADMIN",
      },
    });
    const teamA = await prisma.team.create({
      data: { organizationId: org.id, name: "DB-08 A", slug: "db08-a" },
    });
    const teamB = await prisma.team.create({
      data: { organizationId: org.id, name: "DB-08 B", slug: "db08-b" },
    });
    const website = await prisma.website.create({
      data: {
        organizationId: org.id,
        teamId: teamA.id,
        name: "DB-08 Site",
        domain: `db08-${stamp}.example.com`,
        url: "https://db08.example.com",
      },
    });
    const base = {
      organizationId: org.id,
      encryptedRefreshToken: "db08-dummy-token",
      scopes: [] as string[],
      status: "ACTIVE" as const,
      createdById: user.id,
    };
    // (a) TEAM legacy owner, typed FK pointing at another team.
    await expectCheckFailure("legacy TEAM + typed team B", () =>
      prisma.googleConnection.create({
        data: {
          ...base,
          ownerType: "TEAM",
          ownerId: teamA.id,
          teamId: teamB.id,
          googleAccountEmail: "db08-a@example.com",
        },
      }),
    );
    // (b) TEAM legacy owner carrying a website FK instead.
    await expectCheckFailure("legacy TEAM + website FK", () =>
      prisma.googleConnection.create({
        data: {
          ...base,
          ownerType: "TEAM",
          ownerId: teamA.id,
          websiteId: website.id,
          googleAccountEmail: "db08-b@example.com",
        },
      }),
    );
    // (c) WEBSITE legacy owner carrying a team FK instead.
    await expectCheckFailure("legacy WEBSITE + team FK", () =>
      prisma.googleConnection.create({
        data: {
          ...base,
          ownerType: "WEBSITE",
          ownerId: website.id,
          teamId: teamA.id,
          googleAccountEmail: "db08-c@example.com",
        },
      }),
    );
    // (d) The audit's reproduction: a valid row whose typed FK is moved
    // by direct UPDATE while the legacy columns still name the old owner.
    const valid = await prisma.googleConnection.create({
      data: {
        ...base,
        ownerType: "TEAM",
        ownerId: teamA.id,
        teamId: teamA.id,
        googleAccountEmail: "db08-valid@example.com",
      },
    });
    await expectCheckFailure("UPDATE moves typed FK off legacy owner", () =>
      prisma.googleConnection.update({ where: { id: valid.id }, data: { teamId: teamB.id } }),
    );
    // Control: the valid row above proves in-sync rows still insert.
    console.log("DB08_LEGACY_OWNER_CHECK=ok");
  } finally {
    await prisma.organization.delete({ where: { id: org.id } });
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
