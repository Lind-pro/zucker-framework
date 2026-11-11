-- WP 3.3b: TOTP two-factor, recovery codes, scheduled account deletion (account-security.prisma) and an
-- optional expiry on role assignments. Additive only; existing rows are untouched (expiresAt stays NULL,
-- which means "never expires").
CREATE TABLE "account_two_factor" (
    "userId" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "confirmedAt" TIMESTAMPTZ(3),
    "lastUsedStep" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_two_factor_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "account_two_factor_status_check" CHECK ("status" IN ('pending', 'active')),
    CONSTRAINT "account_two_factor_confirmed_check" CHECK (("status" = 'active') = ("confirmedAt" IS NOT NULL))
);

CREATE TABLE "account_recovery_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_recovery_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "account_recovery_codes_userId_codeHash_key" ON "account_recovery_codes"("userId", "codeHash");

CREATE TABLE "account_deletions" (
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "executeAfter" TIMESTAMPTZ(3) NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "reason" VARCHAR(500),
    CONSTRAINT "account_deletions_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "account_deletions_status_check" CHECK ("status" IN ('scheduled', 'cancelled', 'completed'))
);
CREATE INDEX "account_deletions_status_executeAfter_idx" ON "account_deletions"("status", "executeAfter");

ALTER TABLE "user_roles" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE INDEX "user_roles_expiresAt_idx" ON "user_roles"("expiresAt");
