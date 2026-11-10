-- WP 1.1 catalog unification: plans grant credits per paid period, plan presentation fields,
-- admin-editable credit packs. Additive only: existing plans grant 0 credits and keep their prices.

-- Plan presentation (pricing page cards and translations).
ALTER TABLE "subscription_plans"
  ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "badge" TEXT,
  ADD COLUMN "highlights" JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof("highlights")='array'),
  ADD COLUMN "nameI18n" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "descriptionI18n" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "badgeI18n" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "highlightsI18n" JSONB NOT NULL DEFAULT '{}';

-- Credits granted with each paid period of a plan price; frozen into the order snapshot at checkout.
ALTER TABLE "subscription_plan_prices"
  ADD COLUMN "credits" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "creditExpiryPeriod" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "creditExpiryDays" INTEGER,
  ADD CONSTRAINT "subscription_plan_prices_credits_check" CHECK ("credits" >= 0),
  ADD CONSTRAINT "subscription_plan_prices_credit_expiry_check" CHECK (
    ("creditExpiryDays" IS NULL OR ("creditExpiryDays" BETWEEN 1 AND 36500 AND NOT "creditExpiryPeriod"))
    AND (NOT "creditExpiryPeriod" OR "interval" <> 'lifetime'));

CREATE TABLE "credit_packs" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  "title" TEXT NOT NULL CHECK (length(btrim("title")) BETWEEN 1 AND 100),
  "titleI18n" JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof("titleI18n")='object'),
  "description" TEXT,
  "descriptionI18n" JSONB NOT NULL DEFAULT '{}',
  "credits" INTEGER NOT NULL,
  "expiresInDays" INTEGER,
  "status" BOOLEAN NOT NULL DEFAULT false,
  "order" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_packs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_packs_credits_check" CHECK ("credits" > 0),
  CONSTRAINT "credit_packs_expires_check" CHECK ("expiresInDays" IS NULL OR "expiresInDays" BETWEEN 1 AND 36500)
);
CREATE UNIQUE INDEX "credit_packs_slug_key" ON "credit_packs"("slug");
CREATE INDEX "credit_packs_status_order_idx" ON "credit_packs"("status","order");

CREATE TABLE "credit_pack_prices" (
  "id" TEXT NOT NULL,
  "packId" TEXT NOT NULL,
  "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "amount" TEXT NOT NULL CHECK ("amount" ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_pack_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_pack_prices_packId_fkey" FOREIGN KEY ("packId") REFERENCES "credit_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "credit_pack_prices_packId_currency_key" ON "credit_pack_prices"("packId","currency");

-- One provider reference sells exactly one pack price.
CREATE TABLE "credit_pack_price_refs" (
  "id" TEXT NOT NULL,
  "priceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  CONSTRAINT "credit_pack_price_refs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_pack_price_refs_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "credit_pack_prices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "credit_pack_price_refs_provider_reference_key" ON "credit_pack_price_refs"("provider","reference");
CREATE UNIQUE INDEX "credit_pack_price_refs_priceId_provider_key" ON "credit_pack_price_refs"("priceId","provider");
