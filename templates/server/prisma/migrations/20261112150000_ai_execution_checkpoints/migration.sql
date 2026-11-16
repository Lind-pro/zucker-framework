-- Deploy with workers stopped/drained: older workers do not maintain this paid-submit fence.
ALTER TABLE ai_tasks ADD COLUMN "executionState" text NOT NULL DEFAULT 'NEW',
  ADD COLUMN "generatedOutputs" jsonb;
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_execution_state_check
  CHECK ("executionState" IN ('NEW', 'SUBMITTING', 'ACCEPTED', 'GENERATED', 'STORED'));
-- A legacy attempted task without a provider id has an unknown paid-submit outcome; never resubmit it.
UPDATE ai_tasks a SET "executionState" = CASE
  WHEN j.status::text = 'COMPLETED' THEN 'STORED'
  WHEN a."providerTaskId" IS NOT NULL THEN 'ACCEPTED'
  WHEN j.attempt > 0 THEN 'SUBMITTING'
  ELSE 'NEW' END
FROM async_jobs j WHERE j.id = a.id;
