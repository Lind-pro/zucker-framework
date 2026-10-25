ALTER TABLE "credit_transaction" ADD COLUMN "frozenBalanceBefore" INTEGER, ADD COLUMN "frozenBalanceAfter" INTEGER;
ALTER TABLE "credit_account" ADD CONSTRAINT "credit_account_nonnegative_check" CHECK (balance>=0 AND "frozenBalance">=0);
CREATE TABLE "credit_holds" (
  "id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "amount" INTEGER NOT NULL CHECK ("amount">0),
  "status" TEXT NOT NULL DEFAULT 'HELD' CHECK ("status" IN ('HELD','CONFIRMED','RELEASED')),
  "selectedLotIds" TEXT[] CHECK ("selectedLotIds" IS NOT NULL AND cardinality("selectedLotIds")>0),
  "resourceType" TEXT NOT NULL, "resourceId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "settledAt" TIMESTAMPTZ(3),
  CHECK (("status"='HELD' AND "settledAt" IS NULL) OR ("status"<>'HELD' AND "settledAt" IS NOT NULL))
);
CREATE INDEX "credit_holds_accountId_createdAt_idx" ON "credit_holds"("accountId","createdAt");
CREATE INDEX "credit_holds_resourceType_resourceId_idx" ON "credit_holds"("resourceType","resourceId");
CREATE TABLE "credit_hold_allocations" (
  "holdId" TEXT NOT NULL, "creditLotId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL CHECK ("amount">0), "activeAmount" INTEGER NOT NULL CHECK ("activeAmount">=0),
  "expiredAmount" INTEGER NOT NULL DEFAULT 0 CHECK ("expiredAmount">=0),
  "revokedAmount" INTEGER NOT NULL DEFAULT 0 CHECK ("revokedAmount">=0),
  "releasedAmount" INTEGER NOT NULL DEFAULT 0 CHECK ("releasedAmount">=0), "expiredAt" TIMESTAMPTZ(3),
  CONSTRAINT "credit_hold_allocations_pkey" PRIMARY KEY ("holdId","creditLotId"),
  CONSTRAINT "credit_hold_allocations_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "credit_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "credit_hold_allocations_creditLotId_fkey" FOREIGN KEY ("creditLotId") REFERENCES "credit_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ("amount"::bigint="activeAmount"::bigint+"expiredAmount"+"revokedAmount"+"releasedAmount"),
  CHECK (("expiredAmount"=0 AND "expiredAt" IS NULL) OR ("expiredAmount">0 AND "expiredAt" IS NOT NULL))
);
CREATE INDEX "credit_hold_allocations_creditLotId_activeAmount_idx" ON "credit_hold_allocations"("creditLotId","activeAmount");
CREATE FUNCTION enforce_credit_hold_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id",NEW."accountId",NEW."amount",NEW."selectedLotIds",NEW."resourceType",NEW."resourceId",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id",OLD."accountId",OLD."amount",OLD."selectedLotIds",OLD."resourceType",OLD."resourceId",OLD."createdAt") THEN
    RAISE EXCEPTION 'Credit hold identity is immutable';
  END IF;
  IF OLD."status"<>'HELD' AND ROW(NEW."status",NEW."settledAt") IS DISTINCT FROM ROW(OLD."status",OLD."settledAt") THEN
    RAISE EXCEPTION 'Credit hold terminal decision is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_hold_identity BEFORE UPDATE ON "credit_holds" FOR EACH ROW EXECUTE FUNCTION enforce_credit_hold_identity();
CREATE FUNCTION enforce_credit_hold_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."holdId",NEW."creditLotId",NEW."amount") IS DISTINCT FROM ROW(OLD."holdId",OLD."creditLotId",OLD."amount") THEN
    RAISE EXCEPTION 'Credit hold allocation identity is immutable';
  END IF;
  IF NEW."activeAmount">OLD."activeAmount" OR NEW."expiredAmount"<OLD."expiredAmount" OR NEW."revokedAmount"<OLD."revokedAmount" OR NEW."releasedAmount"<OLD."releasedAmount" THEN
    RAISE EXCEPTION 'Credit hold allocation evidence cannot be reversed';
  END IF;
  IF OLD."expiredAt" IS NOT NULL AND NEW."expiredAt" IS DISTINCT FROM OLD."expiredAt" THEN
    RAISE EXCEPTION 'Credit hold expiry evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credit_hold_allocation BEFORE UPDATE ON "credit_hold_allocations" FOR EACH ROW EXECUTE FUNCTION enforce_credit_hold_allocation();
