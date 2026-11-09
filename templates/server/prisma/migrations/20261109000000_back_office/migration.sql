-- Back office: DB-backed plans with per-interval/currency prices, one current subscription per user
-- plus a payment ledger, mail templates/logs, per-resource quota charging and the order config
-- revision. Additive except for the quota relaxations noted below. Every index and constraint the
-- application relies on for correctness is representable in schema.prisma (CHECK constraints are
-- additional database-side guards that Prisma does not model and never proposes to drop).

CREATE TABLE "subscription_plans" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "slug" TEXT NOT NULL CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  "name" TEXT NOT NULL CHECK (length(btrim("name")) BETWEEN 1 AND 100),
  "description" TEXT,
  "status" BOOLEAN NOT NULL DEFAULT false,
  "order" INTEGER NOT NULL DEFAULT 0,
  "features" JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof("features")='object'),
  "quotas" JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof("quotas")='object'),
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "subscription_plans_slug_key" ON "subscription_plans"("slug");
CREATE INDEX "subscription_plans_status_order_idx" ON "subscription_plans"("status","order");

CREATE TABLE "subscription_plan_prices" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "planId" TEXT NOT NULL,
  "interval" TEXT NOT NULL CHECK ("interval" IN ('month','year','one_time','lifetime')),
  "currency" TEXT NOT NULL CHECK ("currency" ~ '^[A-Z]{3}$'),
  "amount" TEXT NOT NULL CHECK ("amount" ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$'),
  "termDays" INTEGER CHECK ("termDays" BETWEEN 1 AND 36500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_plan_prices_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (("interval"='one_time') = ("termDays" IS NOT NULL))
);
CREATE UNIQUE INDEX "subscription_plan_prices_planId_interval_currency_key" ON "subscription_plan_prices"("planId","interval","currency");

-- One provider reference sells exactly one price, across all plans.
CREATE TABLE "subscription_plan_price_refs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "priceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL CHECK ("provider" ~ '^[a-z][a-z0-9_-]{0,31}$'),
  "reference" TEXT NOT NULL CHECK (length("reference") BETWEEN 1 AND 255),
  CONSTRAINT "subscription_plan_price_refs_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "subscription_plan_prices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "subscription_plan_price_refs_provider_reference_key" ON "subscription_plan_price_refs"("provider","reference");
CREATE UNIQUE INDEX "subscription_plan_price_refs_priceId_provider_key" ON "subscription_plan_price_refs"("priceId","provider");

CREATE TABLE "user_subscriptions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','CANCELED','EXPIRED')),
  "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY' CHECK ("billingCycle" IN ('MONTHLY','YEARLY','ONE_TIME','LIFETIME')),
  "startDate" TIMESTAMPTZ(3) NOT NULL,
  "endDate" TIMESTAMPTZ(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "canceledAt" TIMESTAMPTZ(3),
  "source" TEXT NOT NULL DEFAULT 'admin' CHECK ("source" IN ('admin','payment')),
  "paymentReference" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Plans referenced by any subscription cannot be deleted (RFC 8.2).
  CONSTRAINT "user_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ("endDate" IS NULL OR "endDate" > "startDate"),
  CHECK ("endDate" IS NOT NULL OR "billingCycle"='LIFETIME'),
  -- A lifetime term has no period end to cancel at; it is revoked with EXPIRED instead.
  CHECK ("billingCycle" <> 'LIFETIME' OR "status" <> 'CANCELED')
);
CREATE UNIQUE INDEX "user_subscriptions_userId_key" ON "user_subscriptions"("userId");
CREATE INDEX "user_subscriptions_planId_idx" ON "user_subscriptions"("planId");
CREATE INDEX "user_subscriptions_status_endDate_idx" ON "user_subscriptions"("status","endDate");
CREATE INDEX "user_subscriptions_updatedAt_idx" ON "user_subscriptions"("updatedAt");

-- Payment ledger: every verified plan payment once per reference (idempotency, audit, refunds).
CREATE TABLE "user_subscription_payments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "reference" TEXT NOT NULL CHECK (length("reference") BETWEEN 1 AND 255),
  "userId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "billingCycle" TEXT NOT NULL CHECK ("billingCycle" IN ('MONTHLY','YEARLY','ONE_TIME','LIFETIME')),
  "periodStart" TIMESTAMPTZ(3) NOT NULL,
  "periodEnd" TIMESTAMPTZ(3),
  "orderId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_subscription_payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_subscription_payments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ("periodEnd" IS NULL OR "periodEnd" > "periodStart"),
  CHECK (("periodEnd" IS NULL) = ("billingCycle"='LIFETIME'))
);
CREATE UNIQUE INDEX "user_subscription_payments_reference_key" ON "user_subscription_payments"("reference");
CREATE INDEX "user_subscription_payments_userId_periodStart_idx" ON "user_subscription_payments"("userId","periodStart");
CREATE INDEX "user_subscription_payments_planId_idx" ON "user_subscription_payments"("planId");

CREATE TABLE "email_templates" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "subject" TEXT,
  "htmlContentEn" TEXT NOT NULL,
  "htmlContentZh" TEXT,
  "variables" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "email_templates_key_key" ON "email_templates"("key");

CREATE TABLE "email_logs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT,
  "recipient" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "template" TEXT,
  "provider" TEXT,
  "messageId" TEXT,
  "status" TEXT NOT NULL,
  "errorMessage" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "email_logs_status_createdAt_idx" ON "email_logs"("status","createdAt");
CREATE INDEX "email_logs_recipient_idx" ON "email_logs"("recipient");
CREATE INDEX "email_logs_userId_idx" ON "email_logs"("userId");
CREATE INDEX "email_logs_template_status_userId_createdAt_idx" ON "email_logs"("template","status","userId","createdAt");
CREATE INDEX "email_logs_createdAt_idx" ON "email_logs"("createdAt");

-- Hot-reloaded payment configuration: the connection revision each order was created with.
ALTER TABLE "billing_orders" ADD COLUMN "configRevision" TEXT;

-- Quota: `-1` is an explicit unlimited plan quota (usage is still recorded); other negatives stay
-- invalid. The CHECK names are the ones PostgreSQL generated for the inline constraints of
-- 20261024000900; consumers with their own quota tables must use their own constraint names.
ALTER TABLE "quota_usage" DROP CONSTRAINT IF EXISTS "quota_usage_limit_check";
ALTER TABLE "quota_usage" ADD CONSTRAINT "quota_usage_limit_check" CHECK ("limit">=-1);
ALTER TABLE "quota_reservations" DROP CONSTRAINT IF EXISTS "quota_reservations_limit_check";
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_limit_check" CHECK ("limit">=-1);

-- Charge once per resource and counter: only a RESERVED/CONFIRMED reservation holds the resource's
-- key (sha256 of the length-prefixed UTF-8 parts, written by the quota store), so a released or
-- expired attempt can be retried with a new reservation ID. The former compound unique index also
-- blocked retries; existing rows were unique under it, so the backfill cannot collide.
ALTER TABLE "quota_reservations" ADD COLUMN "activeResourceKey" TEXT;
UPDATE "quota_reservations" SET "activeResourceKey" = encode(sha256(convert_to(
    octet_length("subjectId")::text || ':' || "subjectId" ||
    octet_length("counter")::text || ':' || "counter" ||
    octet_length("resourceType")::text || ':' || "resourceType" ||
    octet_length("resourceId")::text || ':' || "resourceId", 'UTF8')), 'hex')
  WHERE "status" IN ('RESERVED','CONFIRMED');
DROP INDEX "quota_reservations_subjectId_counter_resourceType_resourceI_key";
CREATE UNIQUE INDEX "quota_reservations_activeResourceKey_key" ON "quota_reservations"("activeResourceKey");
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_active_resource_key_check"
  CHECK (("activeResourceKey" IS NOT NULL) = ("status" IN ('RESERVED','CONFIRMED')));

-- Upgraded installations: the administrator setup command seeds permission rows and starter menus
-- only once, so existing databases get the back-office rows here. Idempotent (ON CONFLICT/NOT
-- EXISTS); keep it in sync with BACK_OFFICE_PERMISSIONS and starterAdminMenus. Menus are added only
-- under a starter group that still exists, so a fresh database (no menus yet) is left to the setup
-- command and a group an administrator deleted is not recreated. Customized names are kept.
INSERT INTO "permissions" ("id","name","description")
SELECT code, code, 'Seeded with the starter back office'
FROM unnest(ARRAY['plans:query','plans:add','plans:update','plans:delete','subscriptions:query','subscriptions:update',
  'quota:query','quota:update','mail:query','mail:update']) AS code
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "menus" ("id","name","path","parentId","permissions","sortOrder","status")
SELECT m.id, m.name, m.path, m.parent, ARRAY[m.permission], m.sort, true
FROM (VALUES
  ('starter:plans', '套餐', '/plans', 'starter:commerce', 'plans:query', 12),
  ('starter:user-subscriptions', '用户订阅', '/user-subscriptions', 'starter:commerce', 'subscriptions:query', 13),
  ('starter:quota-usage', '额度用量', '/quota/usage', 'starter:commerce', 'quota:query', 15),
  ('starter:quota-reservations', '额度预留', '/quota/reservations', 'starter:commerce', 'quota:query', 16),
  ('starter:email-templates', '邮件模板', '/mail/templates', 'starter:operations', 'mail:query', 22),
  ('starter:email-logs', '邮件记录', '/mail/logs', 'starter:operations', 'mail:query', 23)
) AS m(id, name, path, parent, permission, sort)
WHERE EXISTS (SELECT 1 FROM "menus" parent WHERE parent."id" = m.parent)
ON CONFLICT ("id") DO NOTHING;
-- The provider-subscription list was renamed to tell it apart from user plan subscriptions.
UPDATE "menus" SET "name" = '支付订阅' WHERE "id" = 'starter:subscriptions' AND "name" = '订阅';
