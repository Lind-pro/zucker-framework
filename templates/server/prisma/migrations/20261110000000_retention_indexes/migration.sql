-- Retention purge (src/maintenance/retention.ts) scans these tables by age; no data is changed here.
--
-- Plain CREATE INDEX blocks inserts/updates on the table while it builds. On deployments where
-- account_api_key_usage, account_sessions or async_jobs are large, create the three indexes first,
-- outside a transaction, while the application runs (see README "Data retention"):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "account_api_key_usage_timestamp_idx" ON "account_api_key_usage"("timestamp");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "account_sessions_revokedAt_idx" ON "account_sessions"("revokedAt");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "async_jobs_kind_status_updatedAt_idx" ON "async_jobs"("kind", "status", "updatedAt");
-- and check that none is left INVALID by a failed concurrent build (DROP INDEX it and repeat), because
-- IF NOT EXISTS below accepts any existing index with that name. Then run `prisma migrate deploy`.
-- CONCURRENTLY is not used here: it cannot run in a transaction block, and Prisma's handling of it
-- inside a migration was not verified for this template.
CREATE INDEX IF NOT EXISTS "account_api_key_usage_timestamp_idx" ON "account_api_key_usage"("timestamp");
CREATE INDEX IF NOT EXISTS "account_sessions_revokedAt_idx" ON "account_sessions"("revokedAt");
CREATE INDEX IF NOT EXISTS "async_jobs_kind_status_updatedAt_idx" ON "async_jobs"("kind", "status", "updatedAt");
