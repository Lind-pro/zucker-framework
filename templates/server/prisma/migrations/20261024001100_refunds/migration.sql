CREATE TABLE billing_refund_payments (
  id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "orderId" TEXT NOT NULL REFERENCES billing_orders(id) ON DELETE RESTRICT,
  "cycleId" TEXT REFERENCES billing_subscription_cycles(id) ON DELETE RESTRICT,
  "providerId" TEXT NOT NULL, "accountScope" TEXT NOT NULL, "paymentKind" TEXT NOT NULL, "paymentId" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL, "sourceId" TEXT NOT NULL, title TEXT NOT NULL, "paidMoney" JSONB NOT NULL,
  "paidMinor" TEXT NOT NULL CHECK ("paidMinor" ~ '^[0-9]+$' AND "paidMinor"::numeric>0),
  "minorScale" INTEGER NOT NULL CHECK ("minorScale" BETWEEN 0 AND 3), "totalCredits" INTEGER NOT NULL CHECK ("totalCredits">0),
  "refundedMinor" TEXT NOT NULL DEFAULT '0' CHECK ("refundedMinor" ~ '^[0-9]+$'),
  "providerPendingMinor" TEXT CHECK ("providerPendingMinor" IS NULL OR "providerPendingMinor" ~ '^[0-9]+$'),
  "recoveredCredits" INTEGER NOT NULL DEFAULT 0, "revokedCredits" INTEGER NOT NULL DEFAULT 0,
  "expiredCredits" INTEGER NOT NULL DEFAULT 0, "suppressedCredits" INTEGER NOT NULL DEFAULT 0,
  "grantRecorded" BOOLEAN NOT NULL DEFAULT false, "grantSource" TEXT, "grantSourceId" TEXT,
  "activeRequestId" TEXT, attention BOOLEAN NOT NULL DEFAULT false, revision INTEGER NOT NULL DEFAULT 0,
  "observedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("providerId","accountScope","paymentKind","paymentId"), UNIQUE("providerId","accountScope","sourceKind","sourceId"),
  CHECK ("refundedMinor"::numeric <= "paidMinor"::numeric),
  CHECK ("recoveredCredits"="revokedCredits"+"expiredCredits"+"suppressedCredits" AND "revokedCredits">=0 AND "expiredCredits">=0 AND "suppressedCredits">=0 AND "recoveredCredits"<="totalCredits")
);
CREATE INDEX billing_refund_payments_owner_idx ON billing_refund_payments("ownerId","createdAt");
CREATE INDEX billing_refund_payments_order_idx ON billing_refund_payments("orderId");
CREATE INDEX billing_refund_payments_cycle_idx ON billing_refund_payments("cycleId");
CREATE TABLE billing_refund_aliases (
  "providerId" TEXT NOT NULL,"accountScope" TEXT NOT NULL,"paymentKind" TEXT NOT NULL,"paymentId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL REFERENCES billing_refund_payments(id) ON DELETE RESTRICT,
  PRIMARY KEY("providerId","accountScope","paymentKind","paymentId")
);
CREATE INDEX billing_refund_aliases_target_idx ON billing_refund_aliases("targetId");
CREATE TABLE billing_refund_requests (
  id TEXT PRIMARY KEY,"targetId" TEXT NOT NULL REFERENCES billing_refund_payments(id) ON DELETE RESTRICT,
  "ownerId" TEXT NOT NULL,"actorId" TEXT NOT NULL,"clientKey" TEXT NOT NULL,"commandKey" TEXT NOT NULL UNIQUE,
  "requestedMinor" TEXT NOT NULL CHECK ("requestedMinor" ~ '^[0-9]+$' AND "requestedMinor"::numeric>0),
  "beforeRefundedMinor" TEXT NOT NULL CHECK ("beforeRefundedMinor" ~ '^[0-9]+$'),
  "expectedRefundedMinor" TEXT NOT NULL CHECK ("expectedRefundedMinor" ~ '^[0-9]+$'),
  money JSONB NOT NULL, reason TEXT, state TEXT NOT NULL DEFAULT 'prepared',"creditState" TEXT NOT NULL DEFAULT 'held',
  "creditAmount" INTEGER NOT NULL CHECK ("creditAmount">=0),"holdId" TEXT REFERENCES credit_holds(id) ON DELETE RESTRICT,
  "expiredCredits" INTEGER NOT NULL DEFAULT 0,"suppressedCredits" INTEGER NOT NULL DEFAULT 0,
  "revokedCredits" INTEGER NOT NULL DEFAULT 0,"shortfallCredits" INTEGER NOT NULL DEFAULT 0,
  "providerRefundId" TEXT,"confirmationBasis" TEXT,"checkedAt" TIMESTAMP(3),revision INTEGER NOT NULL DEFAULT 0,
  "lastReconcileTaskId" TEXT,"reconcileStatus" TEXT NOT NULL DEFAULT 'idle',"reconcileErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE("actorId","clientKey"),
  CHECK (state IN ('prepared','submitting','pending','requires_action','unknown','succeeded','failed','canceled','attention')),
  CHECK ("creditState" IN ('held','settled','released','suppressed','attention')),
  CHECK ("reconcileStatus" IN ('idle','pending','attention'))
);
CREATE INDEX billing_refund_requests_target_idx ON billing_refund_requests("targetId","createdAt");
CREATE INDEX billing_refund_requests_due_idx ON billing_refund_requests(state,"updatedAt");
CREATE TABLE billing_refund_receipts (
  "providerId" TEXT NOT NULL,"accountScope" TEXT NOT NULL,"refundId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL REFERENCES billing_refund_payments(id) ON DELETE RESTRICT,
  "sourceKind" TEXT NOT NULL,"sourceId" TEXT NOT NULL,"commandKey" TEXT,state TEXT NOT NULL,money JSONB,
  "amountMinor" TEXT,"totalRefundedMinor" TEXT,"occurredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY("providerId","accountScope","refundId"),
  CHECK (state IN ('pending','requires_action','unknown','succeeded','failed','canceled')),
  CHECK (state<>'succeeded' OR ("amountMinor" IS NOT NULL AND "amountMinor" ~ '^[0-9]+$' AND "amountMinor"::numeric>0 AND money IS NOT NULL))
);
CREATE INDEX billing_refund_receipts_target_idx ON billing_refund_receipts("targetId",state);
CREATE TABLE billing_refund_events (
  "providerId" TEXT NOT NULL,"accountScope" TEXT NOT NULL,"eventId" TEXT NOT NULL,"sourceKind" TEXT NOT NULL,"sourceId" TEXT NOT NULL,
  "refundId" TEXT,"commandKey" TEXT,evidence JSONB NOT NULL,"targetId" TEXT REFERENCES billing_refund_payments(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending',"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"processedAt" TIMESTAMP(3),
  PRIMARY KEY("providerId","accountScope","eventId"),CHECK(status IN ('pending','processed','attention'))
);
CREATE INDEX billing_refund_events_source_idx ON billing_refund_events("providerId","accountScope","sourceKind","sourceId",status);

CREATE FUNCTION enforce_refund_payment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_order record;
BEGIN
  IF TG_OP='INSERT' THEN
    EXECUTE format('SELECT * FROM %I.billing_orders WHERE id=$1',TG_TABLE_SCHEMA) INTO source_order USING NEW."orderId";
    IF source_order.id IS NULL OR source_order."ownerId"<>NEW."ownerId" OR source_order."providerId"<>NEW."providerId"
      OR source_order."accountScope"<>NEW."accountScope" THEN RAISE EXCEPTION 'Refund target requires its original owned payment'; END IF;
  ELSE
    IF ROW(NEW.id,NEW."ownerId",NEW."orderId",NEW."providerId",NEW."accountScope",NEW."paymentKind",NEW."paymentId",NEW."sourceKind",NEW."sourceId",NEW."paidMoney",NEW."paidMinor",NEW."minorScale",NEW."totalCredits")
      IS DISTINCT FROM ROW(OLD.id,OLD."ownerId",OLD."orderId",OLD."providerId",OLD."accountScope",OLD."paymentKind",OLD."paymentId",OLD."sourceKind",OLD."sourceId",OLD."paidMoney",OLD."paidMinor",OLD."minorScale",OLD."totalCredits")
      THEN RAISE EXCEPTION 'Refund payment identity and policy are immutable'; END IF;
    IF NEW.revision<>OLD.revision+1 OR NEW."refundedMinor"::numeric<OLD."refundedMinor"::numeric OR NEW."recoveredCredits"<OLD."recoveredCredits"
      THEN RAISE EXCEPTION 'Refund payment update must advance monotonically'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_refund_payment_identity BEFORE INSERT OR UPDATE ON billing_refund_payments FOR EACH ROW EXECUTE FUNCTION enforce_refund_payment_identity();
CREATE FUNCTION enforce_refund_request_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record;
BEGIN
  IF TG_OP='INSERT' THEN
    EXECUTE format('SELECT * FROM %I.billing_refund_payments WHERE id=$1',TG_TABLE_SCHEMA) INTO target USING NEW."targetId";
    IF target.id IS NULL OR target."ownerId"<>NEW."ownerId" OR NEW."expectedRefundedMinor"::numeric>target."paidMinor"::numeric
      OR NEW."expectedRefundedMinor"::numeric<>NEW."beforeRefundedMinor"::numeric+NEW."requestedMinor"::numeric
      THEN RAISE EXCEPTION 'Refund request exceeds its bound payment'; END IF;
  ELSE
    IF ROW(NEW.id,NEW."targetId",NEW."ownerId",NEW."actorId",NEW."clientKey",NEW."commandKey",NEW."requestedMinor",NEW."beforeRefundedMinor",NEW."expectedRefundedMinor",NEW.money,NEW.reason,NEW."creditAmount",NEW."holdId")
      IS DISTINCT FROM ROW(OLD.id,OLD."targetId",OLD."ownerId",OLD."actorId",OLD."clientKey",OLD."commandKey",OLD."requestedMinor",OLD."beforeRefundedMinor",OLD."expectedRefundedMinor",OLD.money,OLD.reason,OLD."creditAmount",OLD."holdId")
      THEN RAISE EXCEPTION 'Refund request identity and intent are immutable'; END IF;
    IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Refund request update requires a new revision'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_refund_request_identity BEFORE INSERT OR UPDATE ON billing_refund_requests FOR EACH ROW EXECUTE FUNCTION enforce_refund_request_identity();
CREATE UNIQUE INDEX billing_refund_one_active_request ON billing_refund_requests("targetId")
  WHERE state IN ('prepared','submitting','pending','requires_action','unknown');
CREATE FUNCTION enforce_refund_receipt_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."providerId",NEW."accountScope",NEW."refundId",NEW."targetId",NEW."sourceKind",NEW."sourceId")
    IS DISTINCT FROM ROW(OLD."providerId",OLD."accountScope",OLD."refundId",OLD."targetId",OLD."sourceKind",OLD."sourceId")
    OR (OLD."amountMinor" IS NOT NULL AND NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor")
    OR (OLD.state='succeeded' AND NEW.state<>'succeeded') THEN RAISE EXCEPTION 'Refund receipt identity and successful amount are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_refund_receipt_identity BEFORE UPDATE ON billing_refund_receipts FOR EACH ROW EXECUTE FUNCTION enforce_refund_receipt_identity();
