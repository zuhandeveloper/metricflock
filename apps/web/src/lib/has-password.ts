import { prisma } from "@metricflock/db";

/** True when the user has a credential (email/password) account with a
 *  password set. Google-only users have no such row — with the twoFactor
 *  plugin's `allowPasswordless` they enrol without a password, and the
 *  profile page offers them "set password" instead of "change password".
 *  Mirrors better-auth's own check (`findCredentialAccount` + non-null
 *  password) in `shouldRequirePassword`. */
export async function userHasPassword(userId: string): Promise<boolean> {
  const account = await prisma.account.findFirst({
    where: { userId, providerId: "credential", password: { not: null } },
    select: { id: true },
  });
  return account !== null;
}
