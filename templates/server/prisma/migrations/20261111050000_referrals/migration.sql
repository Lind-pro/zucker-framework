-- Referral programme (WP 3.5a, models/referrals.prisma). Additive only; no existing row is touched.
-- The programme is off by default (policy `referral.enabled`), so these tables stay empty until an
-- operator enables it.

-- CreateTable
CREATE TABLE "referral_codes" (
    "userId" TEXT NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "referral_bindings" (
    "refereeId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_bindings_pkey" PRIMARY KEY ("refereeId")
);

-- CreateTable
CREATE TABLE "referral_rewards" (
    "refereeId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "referrerCredits" INTEGER NOT NULL DEFAULT 0,
    "refereeCredits" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(16) NOT NULL,
    "skipReason" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("refereeId")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE INDEX "referral_bindings_referrerId_boundAt_idx" ON "referral_bindings"("referrerId", "boundAt");

-- CreateIndex
CREATE INDEX "referral_bindings_boundAt_idx" ON "referral_bindings"("boundAt");

-- CreateIndex
CREATE UNIQUE INDEX "referral_rewards_orderId_key" ON "referral_rewards"("orderId");

-- CreateIndex
CREATE INDEX "referral_rewards_referrerId_status_idx" ON "referral_rewards"("referrerId", "status");

-- CreateIndex
CREATE INDEX "referral_rewards_createdAt_idx" ON "referral_rewards"("createdAt");


-- Invariants the application also checks; the database refuses violations from any writer.
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_code_check" CHECK ("code" ~ '^[A-Z0-9]{6,16}$');
ALTER TABLE "referral_bindings" ADD CONSTRAINT "referral_bindings_not_self_check" CHECK ("refereeId" <> "referrerId");
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_not_self_check" CHECK ("refereeId" <> "referrerId");
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_status_check" CHECK ("status" IN ('granted', 'skipped'));
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_amounts_check" CHECK ("referrerCredits" >= 0 AND "refereeCredits" >= 0
  AND ("status" = 'granted' OR ("referrerCredits" = 0 AND "refereeCredits" = 0)));
