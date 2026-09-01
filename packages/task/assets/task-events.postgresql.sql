CREATE TABLE IF NOT EXISTS async_job_events (
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
  CONSTRAINT async_job_events_task_sequence_key UNIQUE ("taskId", "sequence")
);

CREATE INDEX IF NOT EXISTS async_job_events_task_created_idx
  ON async_job_events ("taskId", "createdAt");

INSERT INTO async_job_events (
  "id", "taskId", "sequence", "eventType", "fromStatus", "toStatus",
  "stage", "progress", "attempt", "maxAttempts", "errorCode",
  "errorCategory", "errorRetryable", "workerId",
  "providerRequestId", "createdAt"
)
SELECT
  jobs."id" || ':0', jobs."id", 0, 'SNAPSHOT', NULL, jobs."status",
  jobs."stage", jobs."progress", jobs."attempt", jobs."maxAttempts",
  jobs."errorCode", jobs."errorCategory", jobs."errorRetryable",
  jobs."workerId", jobs."providerRequestId",
  jobs."updatedAt"
FROM async_jobs AS jobs
ON CONFLICT ("taskId", "sequence") DO NOTHING;

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
