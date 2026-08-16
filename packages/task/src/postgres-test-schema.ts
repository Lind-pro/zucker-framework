export const postgresTaskTestSchemaSql = `
  CREATE TYPE async_job_status AS ENUM (
    'QUEUED',
    'PROCESSING',
    'WAITING_PROVIDER',
    'RETRYING',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
  );

  CREATE TABLE async_jobs (
    "id" text PRIMARY KEY,
    "kind" text NOT NULL,
    "resourceType" text NOT NULL,
    "resourceId" text NOT NULL,
    "userId" text,
    "orderId" text,
    "status" async_job_status NOT NULL DEFAULT 'QUEUED',
    "stage" text,
    "progress" integer NOT NULL DEFAULT 0,
    "attempt" integer NOT NULL DEFAULT 0,
    "maxAttempts" integer NOT NULL,
    "idempotencyKey" text NOT NULL UNIQUE,
    "idempotencyFingerprint" text NOT NULL,
    "handlerVersion" text NOT NULL,
    "payload" jsonb NOT NULL,
    "result" jsonb,
    "errorCode" text,
    "errorCategory" text,
    "errorSummary" text,
    "errorRetryable" boolean,
    "errorMetadata" jsonb,
    "providerRequestId" text,
    "workerId" text,
    "leaseToken" text,
    "leaseExpiresAt" timestamptz,
    "heartbeatAt" timestamptz,
    "availableAt" timestamptz NOT NULL,
    "startedAt" timestamptz,
    "completedAt" timestamptz,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL,
    "version" integer NOT NULL DEFAULT 0
  );

  CREATE TABLE async_job_events (
    "id" text PRIMARY KEY,
    "taskId" text NOT NULL REFERENCES async_jobs("id") ON DELETE CASCADE,
    "sequence" integer NOT NULL,
    "eventType" text NOT NULL,
    "fromStatus" async_job_status,
    "toStatus" async_job_status NOT NULL,
    "stage" text,
    "progress" integer NOT NULL,
    "attempt" integer NOT NULL,
    "maxAttempts" integer NOT NULL,
    "errorCode" text,
    "errorCategory" text,
    "errorRetryable" boolean,
    "workerId" text,
    "providerRequestId" text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("taskId", "sequence")
  );

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

  CREATE TRIGGER async_jobs_record_event
  AFTER INSERT OR UPDATE ON async_jobs
  FOR EACH ROW EXECUTE FUNCTION record_async_job_event();
`;
