CREATE TABLE "billing_subscriptions" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "initialOrderId" TEXT NOT NULL UNIQUE REFERENCES "billing_orders"("id") ON DELETE RESTRICT,
  "providerId" TEXT NOT NULL,
  "accountScope" TEXT NOT NULL,
  "providerSubscriptionId" TEXT NOT NULL,
  "catalogReference" TEXT NOT NULL,
  "offer" JSONB NOT NULL,
  "grantBasis" TEXT NOT NULL CHECK ("grantBasis" IN ('period', 'payment')),
  "initialPaymentId" TEXT NOT NULL,
  "initialPaymentKind" TEXT NOT NULL,
  "initialFulfilledAt" TIMESTAMP(3),
  "customerId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "providerStatus" TEXT NOT NULL DEFAULT 'unknown',
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN,
  "canceledAt" TIMESTAMP(3),
  "cancelState" TEXT NOT NULL DEFAULT 'idle' CHECK ("cancelState" IN ('idle', 'submitting', 'confirmed')),
  "cancelMode" TEXT CHECK ("cancelMode" IN ('immediate', 'period_end')),
  "cancelRequestedAt" TIMESTAMP(3),
  "observedAt" TIMESTAMP(3),
  "nextReconcileAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reconcileStatus" TEXT NOT NULL DEFAULT 'pending' CHECK ("reconcileStatus" IN ('pending', 'idle', 'attention')),
  "reconcileErrorCode" TEXT,
  "lastReconcileTaskId" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("providerId", "accountScope", "providerSubscriptionId")
);
CREATE INDEX "billing_subscriptions_ownerId_createdAt_idx" ON "billing_subscriptions"("ownerId", "createdAt");
CREATE INDEX "billing_subscriptions_reconcileStatus_nextReconcileAt_idx" ON "billing_subscriptions"("reconcileStatus", "nextReconcileAt");
CREATE TABLE "billing_subscription_cycles" (
  "id" TEXT PRIMARY KEY,
  "cycleKey" TEXT NOT NULL UNIQUE,
  "bindingId" TEXT NOT NULL REFERENCES "billing_subscriptions"("id") ON DELETE RESTRICT,
  "ownerId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "accountScope" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "catalogReference" TEXT NOT NULL,
  "basis" TEXT NOT NULL CHECK ("basis" IN ('period', 'payment')),
  "periodStart" TIMESTAMP(3),
  "periodEnd" TIMESTAMP(3),
  "paymentId" TEXT NOT NULL,
  "paymentKind" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "paidMoney" JSONB NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "policy" JSONB NOT NULL,
  "initial" BOOLEAN NOT NULL,
  "fulfilledAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("providerId", "accountScope", "paymentKind", "paymentId"),
  CHECK (("basis" = 'period' AND "periodStart" IS NOT NULL AND "periodEnd" IS NOT NULL AND "periodEnd" > "periodStart")
    OR ("basis" = 'payment' AND "periodStart" IS NULL AND "periodEnd" IS NULL))
);
CREATE INDEX "billing_subscription_cycles_bindingId_paidAt_idx" ON "billing_subscription_cycles"("bindingId", "paidAt");
CREATE INDEX "billing_subscription_cycles_ownerId_paidAt_idx" ON "billing_subscription_cycles"("ownerId", "paidAt");

CREATE FUNCTION enforce_subscription_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_order record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE format('SELECT * FROM %I.billing_orders WHERE id = $1', TG_TABLE_SCHEMA)
      INTO source_order USING NEW."initialOrderId";
    IF source_order.id IS NULL OR source_order."ownerId" <> NEW."ownerId" OR source_order."providerId" <> NEW."providerId"
      OR source_order."accountScope" <> NEW."accountScope" OR source_order."subscriptionId" IS DISTINCT FROM NEW."providerSubscriptionId"
      OR source_order."state" <> 'paid' OR source_order."fulfilledAt" IS NULL
      OR source_order."paymentId" IS DISTINCT FROM NEW."initialPaymentId" OR source_order."paymentKind" IS DISTINCT FROM NEW."initialPaymentKind"
      OR source_order."offer" <> NEW."offer" OR source_order."offer"->>'mode' IS DISTINCT FROM 'subscription'
      OR source_order."offer"->>'catalogReference' IS DISTINCT FROM NEW."catalogReference" THEN
      RAISE EXCEPTION 'Subscription binding requires the original verified order';
    END IF;
  ELSE
    IF ROW(NEW."id", NEW."ownerId", NEW."initialOrderId", NEW."providerId", NEW."accountScope", NEW."providerSubscriptionId", NEW."catalogReference", NEW."offer", NEW."grantBasis", NEW."initialPaymentId", NEW."initialPaymentKind", NEW."createdAt")
      IS DISTINCT FROM ROW(OLD."id", OLD."ownerId", OLD."initialOrderId", OLD."providerId", OLD."accountScope", OLD."providerSubscriptionId", OLD."catalogReference", OLD."offer", OLD."grantBasis", OLD."initialPaymentId", OLD."initialPaymentKind", OLD."createdAt") THEN
      RAISE EXCEPTION 'Subscription source identity and policy are immutable';
    END IF;
    IF NEW."revision" <> OLD."revision" + 1 THEN RAISE EXCEPTION 'Subscription update requires a new revision'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_subscription_binding BEFORE INSERT OR UPDATE ON "billing_subscriptions"
FOR EACH ROW EXECUTE FUNCTION enforce_subscription_binding();

CREATE FUNCTION enforce_subscription_cycle_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding record;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Subscription cycle receipts are immutable'; END IF;
  EXECUTE format('SELECT * FROM %I.billing_subscriptions WHERE id = $1', TG_TABLE_SCHEMA)
    INTO binding USING NEW."bindingId";
  IF binding.id IS NULL OR ROW(NEW."ownerId", NEW."providerId", NEW."accountScope", NEW."subscriptionId", NEW."catalogReference", NEW."basis")
    IS DISTINCT FROM ROW(binding."ownerId", binding."providerId", binding."accountScope", binding."providerSubscriptionId", binding."catalogReference", binding."grantBasis")
    OR NEW."policy" IS DISTINCT FROM binding."offer"->'fulfillmentData'
    OR NEW."policyVersion" IS DISTINCT FROM binding."offer"->>'version'
    OR NEW."initial" IS DISTINCT FROM (NEW."paymentId" = binding."initialPaymentId" AND NEW."paymentKind" = binding."initialPaymentKind") THEN
    RAISE EXCEPTION 'Cycle receipt requires its original subscription binding';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_subscription_cycle_receipt BEFORE INSERT OR UPDATE ON "billing_subscription_cycles"
FOR EACH ROW EXECUTE FUNCTION enforce_subscription_cycle_receipt();
