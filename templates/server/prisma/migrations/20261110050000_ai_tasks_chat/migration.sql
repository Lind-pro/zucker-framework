-- WP 2.3: AI media tasks (@zucker-framework/ai-tasks) and chat sessions. Additive; existing tables are unchanged.
-- ai_tasks.id is the durable async_jobs id; that row owns status, lease and fencing.
CREATE TABLE "ai_tasks" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "holdId" TEXT,
    "holdState" TEXT NOT NULL,
    "providerTaskId" TEXT,
    "pollCount" INTEGER NOT NULL DEFAULT 0,
    "pollErrors" INTEGER NOT NULL DEFAULT 0,
    "deferrals" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMPTZ(3),
    "wakeRequestedAt" TIMESTAMPTZ(3),
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "callbackOutcome" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ai_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_tasks_kind_check" CHECK ("kind" IN ('image', 'video', 'audio')),
    CONSTRAINT "ai_tasks_cost_check" CHECK ("cost" >= 0),
    CONSTRAINT "ai_tasks_hold_state_check" CHECK ("holdState" IN ('NONE', 'HELD', 'CONFIRMED', 'RELEASED')),
    CONSTRAINT "ai_tasks_hold_consistent" CHECK (("holdState" = 'NONE') = ("holdId" IS NULL)),
    CONSTRAINT "ai_tasks_counters_check" CHECK ("pollCount" >= 0 AND "pollErrors" >= 0 AND "deferrals" >= 0)
);

CREATE TABLE "ai_task_outputs" (
    "taskId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ai_task_outputs_pkey" PRIMARY KEY ("taskId","index"),
    CONSTRAINT "ai_task_outputs_index_check" CHECK ("index" >= 0),
    CONSTRAINT "ai_task_outputs_bytes_check" CHECK ("bytes" > 0)
);

CREATE TABLE "chats" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chats_amounts_check" CHECK ("messageCount" >= 0 AND "cost" >= 0)
);

CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "parts" JSONB NOT NULL,
    "providerId" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "holdId" TEXT,
    "holdAmount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_messages_role_check" CHECK ("role" IN ('user', 'assistant')),
    CONSTRAINT "chat_messages_status_check" CHECK ("status" IN ('STREAMING', 'COMPLETE', 'FAILED', 'ABORTED')),
    CONSTRAINT "chat_messages_amounts_check" CHECK ("seq" >= 0 AND "inputTokens" >= 0 AND "outputTokens" >= 0
      AND "cost" >= 0 AND "holdAmount" >= 0),
    -- A hold belongs to an assistant turn only.
    CONSTRAINT "chat_messages_hold_check" CHECK ("holdId" IS NULL OR "role" = 'assistant')
);

CREATE INDEX "ai_tasks_owner_created_idx" ON "ai_tasks"("ownerId", "createdAt" DESC, "id" DESC);
CREATE INDEX "ai_tasks_hold_state_idx" ON "ai_tasks"("holdState");
CREATE UNIQUE INDEX "ai_tasks_provider_task_key" ON "ai_tasks"("providerId", "providerTaskId");
CREATE INDEX "chats_owner_updated_idx" ON "chats"("ownerId", "updatedAt" DESC, "id" DESC);
CREATE INDEX "chat_messages_status_updated_idx" ON "chat_messages"("status", "updatedAt");
CREATE UNIQUE INDEX "chat_messages_chat_seq_key" ON "chat_messages"("chatId", "seq");

ALTER TABLE "ai_task_outputs" ADD CONSTRAINT "ai_task_outputs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ai_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
