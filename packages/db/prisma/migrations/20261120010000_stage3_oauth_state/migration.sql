-- Stage 3 — Persisted OAuth state records (audit OAUTH-1/2/5).
--
-- One row per Google connect attempt: SHA-256 hash of the state nonce
-- (raw nonce only travels in the state query parameter), the initiating
-- user + organization, the target owner (team/website), the PKCE code
-- verifier, and a 10-minute expiry. The callback consumes the row
-- atomically (consumedAt), so a state value can never be replayed, and
-- requires the authenticated session to match the initiating user.
--
-- Additive only (new table). Rollback: drop the table; in-flight connect
-- attempts would need to restart (acceptable — 10-minute lifetime).

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" "ConnectionOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_nonceHash_key" ON "OAuthState"("nonceHash");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

