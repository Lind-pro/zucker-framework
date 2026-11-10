import { Inject, Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import { SUBSCRIPTION_RECONCILE_JOB } from '../billing/billing-runtime';
import { QUOTA_RECONCILE_JOB } from '../credits/quota.runtime';

export const RETENTION_OPTIONS = Symbol('RETENTION_OPTIONS');
/** Retention windows in days; 0 keeps a table forever. */
export interface RetentionOptions {
  apiKeyUsageDays: number;
  accessLogDays: number;
  /** Revoked or expired sessions, counted from expiry/revocation. */
  sessionDays: number;
  /** Completed internal maintenance jobs (subscription and quota reconciliation) with their events/outbox. */
  maintenanceJobDays: number;
  /** Minimum time between purge runs. */
  intervalMs: number;
  /** Rows deleted per batch; each batch is its own transaction (bounded lock time). */
  batchSize: number;
  /** Batches per table per run; a run stops early when a batch returns fewer than `batchSize` rows. */
  maxBatchesPerRun: number;
}
/** Jobs that only exist to poll/repair state; user-visible jobs and their results are never purged. */
export const PURGEABLE_JOB_KINDS: readonly string[] = [SUBSCRIPTION_RECONCILE_JOB, QUOTA_RECONCILE_JOB];

function days(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 36500) throw new Error(`${name} must be 0 (keep forever) or a number of days up to 36500`);
  return value;
}
function positive(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return value;
}
export function retentionOptionsFromEnvironment(env: NodeJS.ProcessEnv): RetentionOptions {
  return {
    apiKeyUsageDays: days(env, 'RETENTION_API_KEY_USAGE_DAYS', 90),
    accessLogDays: days(env, 'RETENTION_ACCESS_LOG_DAYS', 180),
    sessionDays: days(env, 'RETENTION_SESSION_DAYS', 30),
    maintenanceJobDays: days(env, 'RETENTION_MAINTENANCE_JOB_DAYS', 30),
    intervalMs: 60 * 60_000,
    batchSize: positive(env, 'RETENTION_BATCH_SIZE', 1000, 50_000),
    maxBatchesPerRun: positive(env, 'RETENTION_MAX_BATCHES_PER_RUN', 50, 10_000),
  };
}

export interface RetentionResult { apiKeyUsage: number; accessLogs: number; sessions: number; maintenanceJobs: number }

/**
 * Bounded purge of append-only operational tables, driven by the single durable Jobs host
 * (no private timer). Each run deletes batches of `batchSize` rows per table, one transaction per
 * batch, until a batch comes back short or `maxBatchesPerRun` is reached (defaults: 1000 x 50, up to
 * 50,000 rows per table per run). Runs happen at most once per `intervalMs` per process; concurrent
 * processes are harmless (deletes are idempotent).
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);
  private lastRunAt = 0;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly jobs: JobsService,
    @Inject(RETENTION_OPTIONS) private readonly options: RetentionOptions) {}

  onModuleInit(): void {
    this.jobs.registerWakeSource({ name: 'data-retention', runOnce: async () => {
      if (Date.now() - this.lastRunAt < this.options.intervalMs) return;
      this.lastRunAt = Date.now();
      const result = await this.purge();
      const total = Object.values(result).reduce((sum, count) => sum + count, 0);
      if (total) this.logger.log(`Retention purge removed ${JSON.stringify(result)}`);
    } });
  }

  async purge(now = new Date()): Promise<RetentionResult> {
    const cutoff = (window: number) => new Date(now.getTime() - window * 86_400_000);
    const limit = this.options.batchSize;
    const maxBatches = Math.max(1, this.options.maxBatchesPerRun ?? 1);
    const run = async (window: number, work: (tx: ApplicationTransaction, before: Date) => Promise<{ rows: unknown[] }>) => {
      if (!window) return 0;
      const before = cutoff(window);
      let removed = 0;
      for (let batch = 0; batch < maxBatches; batch++) {
        // One transaction per batch keeps each lock short; a backlog is drained over several batches.
        const deleted = await this.database.transaction(async tx => (await work(tx, before)).rows.length);
        removed += deleted;
        if (deleted < limit) break;
      }
      return removed;
    };
    return {
      apiKeyUsage: await run(this.options.apiKeyUsageDays, (tx, before) => tx.query(`DELETE FROM account_api_key_usage WHERE id IN (
        SELECT id FROM account_api_key_usage WHERE "timestamp" < $1 ORDER BY "timestamp" LIMIT $2) RETURNING id`, [before, limit])),
      accessLogs: await run(this.options.accessLogDays, (tx, before) => tx.query(`DELETE FROM access_logs WHERE id IN (
        SELECT id FROM access_logs WHERE "requestTime" < $1 ORDER BY "requestTime" LIMIT $2) RETURNING id`, [before, limit])),
      sessions: await run(this.options.sessionDays, (tx, before) => tx.query(`DELETE FROM account_sessions WHERE id IN (
        SELECT id FROM account_sessions WHERE ("revokedAt" IS NOT NULL AND "revokedAt" < $1) OR "expiresAt" < $1 LIMIT $2) RETURNING id`, [before, limit])),
      // Events and outbox rows cascade. Jobs still referenced or with unpublished outbox rows are kept.
      maintenanceJobs: await run(this.options.maintenanceJobDays, (tx, before) => tx.query(`DELETE FROM async_jobs WHERE id IN (
        SELECT j.id FROM async_jobs j WHERE j.kind = ANY($3::text[]) AND j.status = 'COMPLETED' AND j."updatedAt" < $1
          AND NOT EXISTS (SELECT 1 FROM async_job_outbox o WHERE o."taskId" = j.id AND o.status <> 'PUBLISHED')
          AND NOT EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s."lastReconcileTaskId" = j.id)
        ORDER BY j."updatedAt" LIMIT $2) RETURNING id`, [before, limit, [...PURGEABLE_JOB_KINDS]])),
    };
  }
}

@Module({ imports: [JobsModule], providers: [RetentionService,
  { provide: RETENTION_OPTIONS, useFactory: () => retentionOptionsFromEnvironment(process.env) }] })
export class RetentionModule {}
