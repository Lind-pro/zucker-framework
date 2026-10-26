-- CreateEnum
CREATE TYPE "async_job_status" AS ENUM ('QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "async_job_outbox_status" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED');

-- CreateTable
CREATE TABLE "async_jobs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "userId" TEXT,
    "orderId" TEXT,
    "status" "async_job_status" NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "idempotencyFingerprint" TEXT NOT NULL,
    "handlerVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "errorCode" TEXT,
    "errorCategory" TEXT,
    "errorSummary" TEXT,
    "errorRetryable" BOOLEAN,
    "errorMetadata" JSONB,
    "providerRequestId" TEXT,
    "workerId" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "heartbeatAt" TIMESTAMPTZ(3),
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "async_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "async_job_events" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromStatus" "async_job_status",
    "toStatus" "async_job_status" NOT NULL,
    "stage" TEXT,
    "progress" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "maxAttempts" INTEGER NOT NULL,
    "errorCode" TEXT,
    "errorCategory" TEXT,
    "errorRetryable" BOOLEAN,
    "workerId" TEXT,
    "providerRequestId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "async_job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "async_job_outbox" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "async_job_outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workerId" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "async_job_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_records" (
    "taskId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_records_pkey" PRIMARY KEY ("taskId")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "idempotencyFingerprint" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "deliveryRef" TEXT NOT NULL,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workerId" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorRetryable" BOOLEAN,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_messages" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "taskId" TEXT,
    "providerId" TEXT NOT NULL,
    "providerAccountScope" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "dispatchStartedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "async_jobs_idempotencyKey_key" ON "async_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "async_jobs_kind_status_availableAt_idx" ON "async_jobs"("kind", "status", "availableAt");

-- CreateIndex
CREATE INDEX "async_jobs_status_leaseExpiresAt_idx" ON "async_jobs"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "async_jobs_resourceType_resourceId_idx" ON "async_jobs"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "async_jobs_userId_status_createdAt_idx" ON "async_jobs"("userId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "async_jobs_orderId_idx" ON "async_jobs"("orderId");

-- CreateIndex
CREATE INDEX "async_jobs_providerRequestId_idx" ON "async_jobs"("providerRequestId");

-- CreateIndex
CREATE INDEX "async_job_events_taskId_createdAt_idx" ON "async_job_events"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "async_job_events_taskId_sequence_key" ON "async_job_events"("taskId", "sequence");

-- CreateIndex
CREATE INDEX "async_job_outbox_status_availableAt_idx" ON "async_job_outbox"("status", "availableAt");

-- CreateIndex
CREATE INDEX "async_job_outbox_status_leaseExpiresAt_idx" ON "async_job_outbox"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "async_job_outbox_taskId_createdAt_idx" ON "async_job_outbox"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "job_records_ownerId_createdAt_idx" ON "job_records"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_idempotencyKey_key" ON "notification_deliveries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_availableAt_priority_idx" ON "notification_deliveries"("status", "availableAt", "priority");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_leaseExpiresAt_idx" ON "notification_deliveries"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "delivery_messages_ownerId_createdAt_idx" ON "delivery_messages"("ownerId", "createdAt");

-- AddForeignKey
ALTER TABLE "async_job_events" ADD CONSTRAINT "async_job_events_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "async_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "async_job_outbox" ADD CONSTRAINT "async_job_outbox_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "async_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_records" ADD CONSTRAINT "job_records_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "async_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Versioned task event trigger from the public task schema asset.
CREATE OR REPLACE FUNCTION record_async_job_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_sequence integer;
  event_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    event_type := 'CREATED';
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
    event_type := CASE
      WHEN OLD."status" = 'QUEUED' AND NEW."status" = 'PROCESSING' THEN 'CLAIMED'
      WHEN NEW."status" = 'RETRYING' THEN 'RETRY_SCHEDULED'
      WHEN OLD."status" = 'RETRYING' AND NEW."status" = 'QUEUED' THEN 'REQUEUED'
      WHEN OLD."status" IN ('PROCESSING', 'WAITING_PROVIDER')
        AND NEW."status" = 'QUEUED' THEN 'LEASE_RECOVERED'
      WHEN OLD."status" = 'FAILED' AND NEW."status" = 'QUEUED' THEN 'MANUAL_REDRIVE'
      WHEN NEW."status" = 'COMPLETED' THEN 'COMPLETED'
      WHEN NEW."status" = 'FAILED' THEN 'FAILED'
      WHEN NEW."status" = 'CANCELLED' THEN 'CANCELLED'
      ELSE 'STATUS_CHANGED'
    END;
  ELSIF NEW."stage" IS DISTINCT FROM OLD."stage"
    OR NEW."progress" IS DISTINCT FROM OLD."progress"
    OR NEW."providerRequestId" IS DISTINCT FROM OLD."providerRequestId" THEN
    event_type := 'PROGRESS';
  ELSE
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX("sequence") + 1, 0)
  INTO next_sequence
  FROM async_job_events
  WHERE "taskId" = NEW."id";

  INSERT INTO async_job_events (
    "id", "taskId", "sequence", "eventType", "fromStatus", "toStatus",
    "stage", "progress", "attempt", "maxAttempts", "errorCode",
    "errorCategory", "errorRetryable", "workerId",
    "providerRequestId", "createdAt"
  ) VALUES (
    NEW."id" || ':' || next_sequence::text,
    NEW."id",
    next_sequence,
    event_type,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD."status" ELSE NULL END,
    NEW."status",
    NEW."stage",
    NEW."progress",
    NEW."attempt",
    NEW."maxAttempts",
    NEW."errorCode",
    NEW."errorCategory",
    NEW."errorRetryable",
    NEW."workerId",
    NEW."providerRequestId",
    NEW."updatedAt"
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS async_jobs_record_event ON async_jobs;
CREATE TRIGGER async_jobs_record_event
AFTER INSERT OR UPDATE ON async_jobs
FOR EACH ROW EXECUTE FUNCTION record_async_job_event();


-- Durable delivery state/lease contract from the public PostgreSQL adapter.
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_delivery_status_check" CHECK ("status" IN ('PENDING','PROCESSING','RETRYING','DELIVERED','DEAD')),
  ADD CONSTRAINT "notification_delivery_attempt_check" CHECK ("attempt">=0 AND "maxAttempts">0),
  ADD CONSTRAINT "notification_delivery_lease_check" CHECK (
    ("status"='PROCESSING' AND "workerId" IS NOT NULL AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    OR ("status"<>'PROCESSING' AND "workerId" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
  );

-- Retries must not reroute or rewrite a previously reserved private envelope.
CREATE FUNCTION enforce_delivery_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id",NEW."ownerId",NEW."taskId",NEW."providerId",NEW."providerAccountScope",NEW."recipient",NEW."subject",NEW."text",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id",OLD."ownerId",OLD."taskId",OLD."providerId",OLD."providerAccountScope",OLD."recipient",OLD."subject",OLD."text",OLD."createdAt") THEN
    RAISE EXCEPTION 'Delivery envelope identity is immutable';
  END IF;
  IF OLD."dispatchStartedAt" IS NOT NULL AND NEW."dispatchStartedAt" IS DISTINCT FROM OLD."dispatchStartedAt" THEN
    RAISE EXCEPTION 'Delivery dispatch evidence cannot be removed or reset';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delivery_message_identity BEFORE UPDATE ON "delivery_messages"
FOR EACH ROW EXECUTE FUNCTION enforce_delivery_message_identity();
