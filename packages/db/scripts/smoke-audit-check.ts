// Smoke-test fixture (Stage 7): verifies DB-10 audit coverage — auth
// sign-in events recorded, ipAddress populated on app mutations.
// Prints AUTH_SIGNIN_COUNT=<n> AUDIT_WITH_IP=<n>. CI-only fixture.
import { prisma } from "../src/client";

async function main() {
  const signIns = await prisma.auditLog.count({ where: { action: "auth.sign_in" } });
  const withIp = await prisma.auditLog.count({ where: { ipAddress: { not: null } } });
  const signUps = await prisma.auditLog.count({ where: { action: "auth.sign_up" } });
  console.log(`AUTH_SIGNIN_COUNT=${signIns} AUTH_SIGNUP_COUNT=${signUps} AUDIT_WITH_IP=${withIp}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
