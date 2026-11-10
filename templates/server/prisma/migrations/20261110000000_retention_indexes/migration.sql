-- Retention purge (src/maintenance/retention.ts) scans these tables by age; no data is changed here.
CREATE INDEX "account_api_key_usage_timestamp_idx" ON "account_api_key_usage"("timestamp");
CREATE INDEX "account_sessions_revokedAt_idx" ON "account_sessions"("revokedAt");
CREATE INDEX "async_jobs_kind_status_updatedAt_idx" ON "async_jobs"("kind", "status", "updatedAt");
