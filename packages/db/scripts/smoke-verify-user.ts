// Smoke-test helper: marks a user's email as verified so the smoke test
// can sign in with an account created through the public sign-up API
// (the real verification link is emailed; CI has no inbox).
// Usage: tsx scripts/smoke-verify-user.ts <email>
import { prisma } from "../src/client";

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("usage: smoke-verify-user.ts <email>");
  const res = await prisma.user.updateMany({
    where: { email: { equals: email, mode: "insensitive" } },
    data: { emailVerified: true },
  });
  if (res.count === 0) throw new Error(`no user with email ${email}`);
  console.log(`verified: ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
