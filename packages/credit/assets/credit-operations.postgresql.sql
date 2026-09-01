CREATE TABLE credit_account_locks (
  "accountId" varchar(191) PRIMARY KEY,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE credit_operation_receipts (
  "idempotencyKey" varchar(200) PRIMARY KEY,
  "accountId" varchar(191) NOT NULL,
  "operationType" varchar(64) NOT NULL,
  "amount" integer NOT NULL CHECK ("amount" > 0),
  "resourceType" varchar(64) NOT NULL,
  "resourceId" varchar(191),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "credit_operation_receipts_accountId_createdAt_idx"
  ON credit_operation_receipts ("accountId", "createdAt");
