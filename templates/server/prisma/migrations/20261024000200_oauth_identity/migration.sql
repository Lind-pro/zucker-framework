ALTER TABLE "account_sessions" ADD COLUMN "authMethod" TEXT NOT NULL DEFAULT 'password';
ALTER TABLE "account_sessions" ADD COLUMN "oauthBindingId" TEXT;
ALTER TABLE "account_sessions" ADD CONSTRAINT "account_sessions_oauthBindingId_fkey"
  FOREIGN KEY ("oauthBindingId") REFERENCES "third_party_binds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "account_oauth_intents" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "provider" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "nonce" TEXT NOT NULL,
  "codeVerifier" TEXT,
  "browserBindingHash" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "returnPath" TEXT NOT NULL,
  "userId" TEXT,
  "sessionId" TEXT,
  CONSTRAINT "account_oauth_intents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_oauth_intents_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "account_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "account_oauth_intents_tokenHash_key" ON "account_oauth_intents"("tokenHash");
CREATE INDEX "account_oauth_intents_expiresAt_idx" ON "account_oauth_intents"("expiresAt");

CREATE TABLE "account_oauth_proofs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "purpose" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "email" TEXT,
  "emailVerified" BOOLEAN NOT NULL,
  "displayName" TEXT,
  "avatarUrl" TEXT,
  "browserBindingHash" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "returnPath" TEXT NOT NULL,
  "userId" TEXT,
  "sessionId" TEXT,
  CONSTRAINT "account_oauth_proofs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_oauth_proofs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "account_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "account_oauth_proofs_tokenHash_key" ON "account_oauth_proofs"("tokenHash");
CREATE INDEX "account_oauth_proofs_expiresAt_idx" ON "account_oauth_proofs"("expiresAt");
