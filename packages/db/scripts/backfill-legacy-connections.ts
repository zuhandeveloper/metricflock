// One-off backfill for A-DB-12: legacy `WebsiteIntegration` rows left by
// the Stage 2 DB-7 backfill carry `mappingStatus = "MAPPED"` with
// `googleConnectionId = NULL` and no property FK — the property id lives
// only in the `externalId` string. Those rows are now unmappable at read
// time (`getAuthorizedClientForIntegration` throws LEGACY_CONNECTION_MISSING
// instead of falling back to another connection's credentials), and this
// script resolves or clears them:
//
// - RESOLVE: the property (`externalId`) is found among the rows a
//   connection in the same organization discovered (GA4 `propertyId`,
//   Search Console `siteUrl`, AdSense `accountId`, Ad Manager
//   `networkCode`). The row is linked to that connection (most recently
//   updated ACTIVE connection wins when several discovered it — any of
//   them yields the same property's data) and the provider's FK is set,
//   the other three FKs NULLed (same full-FK-set write the map route
//   makes since A-DB-07).
// - DEMOTE: no connection in the organization has the property
//   discovered, so the row cannot be fetched under any credentials. It
//   is demoted to UNMAPPED (never deleted): `externalId` is preserved,
//   `isPrimary` cleared (A-DB-07 CHECK: primary ⇒ MAPPED) and all four
//   FKs NULLed, so the user can re-map it via the UI.
//
// Conservative by design: rows are never deleted, and a row whose
// website no longer exists is skipped (it should have cascade-deleted;
// it is counted, not touched). Idempotent — re-run until `remaining` is
// 0. Bounded: at most `--limit` rows per run (default 100).
//
// Run: DOTENV_CONFIG_PATH=../../apps/web/.env pnpm --filter
// @metricflock/db exec tsx scripts/backfill-legacy-connections.ts [--limit N]
import { pathToFileURL } from "node:url";
import { prisma } from "../src/client";
import { createLogger } from "@metricflock/shared";

const log = createLogger("db/backfill-legacy-connections");

export const DEFAULT_LIMIT = 100;

type DiscoveredMatch = {
  id: string;
  connection: { id: string; status: string; updatedAt: Date };
};

type FkField = "googlePropertyId" | "searchConsolePropertyId" | "adsenseAccountId" | "adManagerNetworkId";

function fkUpdate(fk: FkField, id: string) {
  const out: Record<FkField, string | null> = {
    googlePropertyId: null,
    searchConsolePropertyId: null,
    adsenseAccountId: null,
    adManagerNetworkId: null,
  };
  out[fk] = id;
  return out;
}

function fkFieldFor(provider: string): FkField {
  switch (provider) {
    case "SEARCH_CONSOLE":
      return "searchConsolePropertyId";
    case "ADSENSE":
      return "adsenseAccountId";
    case "AD_MANAGER":
      return "adManagerNetworkId";
    case "GA4":
    default:
      return "googlePropertyId";
  }
}

/** Discovered-property rows for `externalId` under connections of one
 *  organization. The connection join is what makes a match fetchable:
 *  a property discovered under another org's connection must never
 *  resolve a row here. */
async function findDiscovered(
  db: typeof prisma,
  provider: string,
  externalId: string,
  organizationId: string,
): Promise<DiscoveredMatch[]> {
  const include = { connection: { select: { id: true, status: true, updatedAt: true } } };
  switch (provider) {
    case "SEARCH_CONSOLE":
      return db.searchConsoleProperty.findMany({
        where: { siteUrl: externalId, connection: { organizationId } },
        include,
      });
    case "ADSENSE":
      return db.adSenseAccount.findMany({
        where: { accountId: externalId, connection: { organizationId } },
        include,
      });
    case "AD_MANAGER":
      return db.adManagerNetwork.findMany({
        where: { networkCode: externalId, connection: { organizationId } },
        include,
      });
    case "GA4":
    default:
      return db.googleProperty.findMany({
        where: { propertyId: externalId, connection: { organizationId } },
        include,
      });
  }
}

/** Prefer an ACTIVE connection, then the most recently updated one —
 *  the same recency order `resolveConnectionForWebsite` uses. Any
 *  connection that discovered the property yields the same property's
 *  data, so the choice is about liveness, not identity. */
function pickMatch(matches: DiscoveredMatch[]): DiscoveredMatch {
  return [...matches].sort((a, b) => {
    const active = (m: DiscoveredMatch) => (m.connection.status === "ACTIVE" ? 1 : 0);
    if (active(a) !== active(b)) return active(b) - active(a);
    return b.connection.updatedAt.getTime() - a.connection.updatedAt.getTime();
  })[0] as DiscoveredMatch;
}

export type BackfillResult = {
  examined: number;
  resolved: number;
  demoted: number;
  skipped: number;
  remaining: number;
  demotedIds: string[];
};

export async function backfillLegacyConnections(
  db: typeof prisma,
  opts: { limit?: number } = {},
): Promise<BackfillResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const rows = await db.websiteIntegration.findMany({
    where: { mappingStatus: "MAPPED", googleConnectionId: null },
    orderBy: { id: "asc" },
    take: limit,
  });
  let resolved = 0;
  let demoted = 0;
  let skipped = 0;
  const demotedIds: string[] = [];
  for (const row of rows) {
    const website = await db.website.findUnique({
      where: { id: row.websiteId },
      select: { organizationId: true },
    });
    if (!website) {
      skipped++;
      log.warn("legacy integration without a website, skipped", { integrationId: row.id });
      continue;
    }
    const matches = await findDiscovered(db, row.provider, row.externalId, website.organizationId);
    if (matches.length === 0) {
      await db.websiteIntegration.update({
        where: { id: row.id },
        data: {
          mappingStatus: "UNMAPPED",
          isPrimary: false,
          googlePropertyId: null,
          searchConsolePropertyId: null,
          adsenseAccountId: null,
          adManagerNetworkId: null,
        },
      });
      demoted++;
      demotedIds.push(row.id);
      continue;
    }
    const best = pickMatch(matches);
    await db.websiteIntegration.update({
      where: { id: row.id },
      data: { googleConnectionId: best.connection.id, ...fkUpdate(fkFieldFor(row.provider), best.id) },
    });
    resolved++;
  }
  const remaining = await db.websiteIntegration.count({
    where: { mappingStatus: "MAPPED", googleConnectionId: null },
  });
  const result: BackfillResult = { examined: rows.length, resolved, demoted, skipped, remaining, demotedIds };
  log.info("backfilled legacy NULL-connection mappings", result);
  return result;
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error("Usage: tsx scripts/backfill-legacy-connections.ts [--limit N] (N a positive integer)");
    process.exit(1);
  }
  const result = await backfillLegacyConnections(prisma, { limit });
  console.log(
    `BACKFILL_LEGACY_CONNECTIONS examined=${result.examined} resolved=${result.resolved} ` +
      `demoted=${result.demoted} skipped=${result.skipped} remaining=${result.remaining}`,
  );
  if (result.demotedIds.length > 0) console.log(`demoted (re-map in the UI): ${result.demotedIds.join(", ")}`);
  if (result.remaining > 0) console.log(`Re-run to continue: ${result.remaining} legacy rows remain.`);
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
