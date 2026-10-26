-- AlterTable
ALTER TABLE "credit_transaction" ADD COLUMN     "balanceAfter" INTEGER,
ADD COLUMN     "balanceBefore" INTEGER,
ADD COLUMN     "ledgerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "metadata" JSONB;

-- CreateTable
CREATE TABLE "billing_orders" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accountScope" TEXT NOT NULL,
    "offer" JSONB NOT NULL,
    "providerMetadata" JSONB,
    "successUrl" TEXT NOT NULL,
    "cancelUrl" TEXT NOT NULL,
    "createKey" TEXT NOT NULL,
    "captureKey" TEXT NOT NULL,
    "creationState" TEXT NOT NULL,
    "captureState" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "checkoutId" TEXT,
    "checkoutUrl" TEXT,
    "paymentId" TEXT,
    "paymentKind" TEXT,
    "subscriptionId" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "billing_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_fulfillments" (
    "orderId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "credits" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_fulfillments_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "billing_outbox" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_lots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "amount" INTEGER NOT NULL,
    "remainingAmount" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "description" TEXT,
    "isExpired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_consumptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "transactionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_allocations" (
    "id" TEXT NOT NULL,
    "consumptionId" TEXT NOT NULL,
    "creditLotId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "amount" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "credit_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_account_locks" (
    "accountId" VARCHAR(191) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_account_locks_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "credit_operation_receipts" (
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "accountId" VARCHAR(191) NOT NULL,
    "operationType" VARCHAR(64) NOT NULL,
    "amount" INTEGER NOT NULL,
    "resourceType" VARCHAR(64) NOT NULL,
    "resourceId" VARCHAR(191),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_operation_receipts_pkey" PRIMARY KEY ("idempotencyKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_orders_createKey_key" ON "billing_orders"("createKey");

-- CreateIndex
CREATE UNIQUE INDEX "billing_orders_captureKey_key" ON "billing_orders"("captureKey");

-- CreateIndex
CREATE INDEX "billing_orders_ownerId_createdAt_idx" ON "billing_orders"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_orders_providerId_accountScope_checkoutId_key" ON "billing_orders"("providerId", "accountScope", "checkoutId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_orders_providerId_accountScope_paymentKind_paymentI_key" ON "billing_orders"("providerId", "accountScope", "paymentKind", "paymentId");

-- CreateIndex
CREATE INDEX "billing_fulfillments_ownerId_createdAt_idx" ON "billing_fulfillments"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "billing_outbox_status_availableAt_idx" ON "billing_outbox"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_outbox_kind_aggregateId_key" ON "billing_outbox"("kind", "aggregateId");

-- CreateIndex
CREATE INDEX "credit_lots_userId_isExpired_createdAt_idx" ON "credit_lots"("userId", "isExpired", "createdAt");

-- CreateIndex
CREATE INDEX "credit_lots_source_sourceId_idx" ON "credit_lots"("source", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_consumptions_transactionId_key" ON "credit_consumptions"("transactionId");

-- CreateIndex
CREATE INDEX "credit_consumptions_userId_createdAt_idx" ON "credit_consumptions"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "credit_allocations_consumptionId_creditLotId_key" ON "credit_allocations"("consumptionId", "creditLotId");

-- CreateIndex
CREATE INDEX "credit_operation_receipts_accountId_createdAt_idx" ON "credit_operation_receipts"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_fulfillments" ADD CONSTRAINT "billing_fulfillments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "billing_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_allocations" ADD CONSTRAINT "credit_allocations_consumptionId_fkey" FOREIGN KEY ("consumptionId") REFERENCES "credit_consumptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_allocations" ADD CONSTRAINT "credit_allocations_creditLotId_fkey" FOREIGN KEY ("creditLotId") REFERENCES "credit_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

