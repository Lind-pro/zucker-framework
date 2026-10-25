CREATE TABLE "account_api_keys" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "keyPrefix" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY['account:read']::TEXT[],
  "rateLimit" INTEGER NOT NULL DEFAULT 60,
  "dailyLimit" INTEGER,
  "monthlyLimit" INTEGER,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastUsedAt" TIMESTAMP(3),
  "usageCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "account_api_keys_keyHash_key" ON "account_api_keys"("keyHash");
CREATE INDEX "account_api_keys_userId_revokedAt_idx" ON "account_api_keys"("userId", "revokedAt");
CREATE INDEX "account_api_keys_expiresAt_idx" ON "account_api_keys"("expiresAt");
CREATE TABLE "account_api_key_usage" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "apiKeyId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "responseTime" INTEGER NOT NULL,
  "errorMessage" TEXT,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_api_key_usage_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "account_api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_api_key_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "account_api_key_usage_apiKeyId_timestamp_idx" ON "account_api_key_usage"("apiKeyId", "timestamp");
CREATE INDEX "account_api_key_usage_userId_timestamp_idx" ON "account_api_key_usage"("userId", "timestamp");
