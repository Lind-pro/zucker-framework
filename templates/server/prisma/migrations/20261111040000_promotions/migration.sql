-- WP 3.4: promo codes (models/promotions.prisma). New tables only; existing rows are untouched.
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "alias" TEXT,
    "providerId" TEXT NOT NULL,
    "providerCode" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "currency" TEXT,
    "discountType" TEXT NOT NULL,
    "percentOff" INTEGER,
    "amountOff" TEXT,
    "maxRedemptions" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "promotions_alias_key" ON "promotions"("alias");
CREATE INDEX "promotions_status_providerId_idx" ON "promotions"("status", "providerId");

CREATE TABLE "promotion_redemptions" (
    "orderId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reference" TEXT,
    "discountAmount" TEXT NOT NULL,
    "payableAmount" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "redeemedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("orderId")
);

CREATE INDEX "promotion_redemptions_promotionId_status_idx" ON "promotion_redemptions"("promotionId", "status");
CREATE INDEX "promotion_redemptions_ownerId_idx" ON "promotion_redemptions"("ownerId");
