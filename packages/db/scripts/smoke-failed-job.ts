// Smoke fixture (Stage 8): insert a terminally FAILED sync-job row with
// a retained payload so the DLQ list + requeue endpoints can be
// exercised end to end. Prints FAILED_JOB_ID=<id>.
import { prisma } from "../src/client";

async function main() {
  const website = await prisma.website.findFirst({ select: { id: true } });
  if (!website) throw new Error("no website found for failed-job fixture");
  const row = await prisma.analyticsSyncJob.create({
    data: {
      websiteId: website.id,
      type: "GA4_HISTORICAL",
      status: "FAILED",
      attempts: 5,
      lastError: "smoke fixture: simulated terminal failure",
      payload: { websiteId: website.id },
    },
    select: { id: true },
  });
  console.log(`FAILED_JOB_ID=${row.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
