CREATE TABLE "quota_usage" (
  "subjectId" TEXT NOT NULL, "counter" TEXT NOT NULL, "period" TEXT NOT NULL,
  "limit" INTEGER NOT NULL CHECK ("limit">=0), "used" INTEGER NOT NULL DEFAULT 0 CHECK ("used">=0),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quota_usage_pkey" PRIMARY KEY ("subjectId","counter","period")
);
CREATE TABLE "quota_reservations" (
  "id" TEXT NOT NULL PRIMARY KEY, "subjectId" TEXT NOT NULL, "counter" TEXT NOT NULL,
  "period" TEXT NOT NULL, "amount" INTEGER NOT NULL CHECK ("amount">0), "limit" INTEGER NOT NULL CHECK ("limit">=0),
  "policyVersion" TEXT NOT NULL, "resourceType" TEXT NOT NULL, "resourceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RESERVED' CHECK ("status" IN ('RESERVED','CONFIRMED','RELEASED','EXPIRED')),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMPTZ(3), "reason" TEXT,
  CHECK (("status"='RESERVED' AND "finishedAt" IS NULL) OR ("status"<>'RESERVED' AND "finishedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "quota_reservations_subjectId_counter_resourceType_resourceI_key" ON "quota_reservations"("subjectId","counter","resourceType","resourceId");
CREATE INDEX "quota_reservations_subjectId_counter_period_status_idx" ON "quota_reservations"("subjectId","counter","period","status");
CREATE INDEX "quota_reservations_status_expiresAt_idx" ON "quota_reservations"("status","expiresAt");
CREATE FUNCTION enforce_quota_reservation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id",NEW."subjectId",NEW."counter",NEW."period",NEW."amount",NEW."limit",NEW."policyVersion",NEW."resourceType",NEW."resourceId",NEW."expiresAt",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id",OLD."subjectId",OLD."counter",OLD."period",OLD."amount",OLD."limit",OLD."policyVersion",OLD."resourceType",OLD."resourceId",OLD."expiresAt",OLD."createdAt") THEN
    RAISE EXCEPTION 'Quota reservation identity is immutable';
  END IF;
  IF OLD."status"<>'RESERVED' AND ROW(NEW."status",NEW."finishedAt",NEW."reason") IS DISTINCT FROM ROW(OLD."status",OLD."finishedAt",OLD."reason") THEN
    RAISE EXCEPTION 'Quota reservation terminal state is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quota_reservation_identity BEFORE UPDATE ON "quota_reservations" FOR EACH ROW EXECUTE FUNCTION enforce_quota_reservation_identity();
