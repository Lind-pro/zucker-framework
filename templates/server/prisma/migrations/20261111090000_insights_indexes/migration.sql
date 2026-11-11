-- WP 3.Z: indexes for the operations-insights range queries (WP 3.5b) and the inbox event scans (WP 3.2).
-- Additive only. Each is a plain CREATE INDEX (Prisma runs a migration in one transaction, so not
-- CONCURRENTLY): on a large existing installation, apply during a quiet period (see docs/known-issues.md).

-- Insights: range scans by business timestamp.
CREATE INDEX IF NOT EXISTS "billing_orders_fulfilledAt_idx" ON "billing_orders"("fulfilledAt");
CREATE INDEX IF NOT EXISTS "billing_subscription_cycles_paidAt_idx" ON "billing_subscription_cycles"("paidAt");
CREATE INDEX IF NOT EXISTS "users_createTime_idx" ON "users"("createTime");
CREATE INDEX IF NOT EXISTS "credit_lots_createdAt_idx" ON "credit_lots"("createdAt");
CREATE INDEX IF NOT EXISTS "credit_consumptions_createdAt_idx" ON "credit_consumptions"("createdAt");
CREATE INDEX IF NOT EXISTS "ai_tasks_created_idx" ON "ai_tasks"("createdAt");
CREATE INDEX IF NOT EXISTS "chat_messages_created_idx" ON "chat_messages"("createdAt");

-- Inbox scans: keyset order of the billing outbox per kind, and finished jobs by completion time.
CREATE INDEX IF NOT EXISTS "billing_outbox_kind_createdAt_id_idx" ON "billing_outbox"("kind", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "async_jobs_completedAt_id_idx" ON "async_jobs"("completedAt", "id");
