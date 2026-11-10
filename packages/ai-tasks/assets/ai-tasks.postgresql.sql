-- Reference PostgreSQL DDL for @zucker-framework/ai-tasks (mirrors assets/ai-tasks.prisma).
-- Requires the durable task control plane (async_jobs) from @zucker-framework/task.
-- ai_tasks.id is the async_jobs id; the durable row owns lifecycle status, lease and fencing.

CREATE TABLE ai_tasks (
  "id" text PRIMARY KEY,
  "ownerId" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('image', 'video', 'audio')),
  "providerId" text NOT NULL,
  "model" text NOT NULL,
  "cost" integer NOT NULL CHECK ("cost" >= 0),
  "holdId" text,
  "holdState" text NOT NULL CHECK ("holdState" IN ('NONE', 'HELD', 'CONFIRMED', 'RELEASED')),
  "providerTaskId" text,
  "pollCount" integer NOT NULL DEFAULT 0,
  "pollErrors" integer NOT NULL DEFAULT 0,
  "deferrals" integer NOT NULL DEFAULT 0,
  "nextPollAt" timestamptz,
  "wakeRequestedAt" timestamptz,
  "deadlineAt" timestamptz NOT NULL,
  "callbackOutcome" jsonb,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  CONSTRAINT ai_tasks_hold_consistent CHECK (("holdState" = 'NONE') = ("holdId" IS NULL))
);

CREATE INDEX ai_tasks_owner_created_idx ON ai_tasks ("ownerId", "createdAt" DESC, "id" DESC);
CREATE INDEX ai_tasks_hold_state_idx ON ai_tasks ("holdState");
CREATE UNIQUE INDEX ai_tasks_provider_task_key ON ai_tasks ("providerId", "providerTaskId");

CREATE TABLE ai_task_outputs (
  "taskId" text NOT NULL REFERENCES ai_tasks("id") ON DELETE CASCADE,
  "index" integer NOT NULL CHECK ("index" >= 0),
  "storageKey" text NOT NULL,
  "contentType" text NOT NULL,
  "bytes" integer NOT NULL CHECK ("bytes" > 0),
  "sha256" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  PRIMARY KEY ("taskId", "index")
);
