import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { JobsService } from '../jobs/jobs.service';
import { INBOX_SOURCES, type InboxCursor, type InboxSource } from './inbox-sources';
import { InboxService } from './inbox.service';
import { InboxEmitError } from './inbox-types';

export const INBOX_OPTIONS = Symbol('INBOX_OPTIONS');
export const INBOX_WAKE_SOURCE = 'inbox-events';
/** Optional override of the source list (tests, or a product adding its own `defineInboxSource`). */
export const INBOX_SOURCES_TOKEN = Symbol('INBOX_SOURCES');

export interface InboxOptions {
  /** Read or archived notifications older than this are deleted; 0 keeps them forever. */
  retentionDays: number;
  /** Minimum time between event scans per process (the Jobs host wakes sources every second). */
  scanIntervalMs: number;
  /** Minimum time between retention runs per process. */
  retentionIntervalMs: number;
  /**
   * Source rows are consumed only once they are this old. It must exceed the longest application
   * transaction (TRANSACTION_LIMITS.timeout = 30 s) plus clock skew between replicas, so a row whose
   * transaction committed after a newer row was scanned is never skipped by the cursor.
   */
  settleMs: number;
  /** A new installation starts this far back, so history from before the inbox existed is not announced. */
  backfillMs: number;
  /** Rows per source per batch. */
  batchSize: number;
  /** Batches per source per run. */
  maxBatchesPerRun: number;
  retentionBatchSize: number;
  maxRetentionBatches: number;
}

export function inboxOptionsFromEnvironment(env: NodeJS.ProcessEnv): InboxOptions {
  const raw = env.INBOX_RETENTION_DAYS?.trim();
  const retentionDays = raw === undefined || raw === '' ? 90 : Number(raw);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > 36500)
    throw new Error('INBOX_RETENTION_DAYS must be 0 (keep forever) or a number of days up to 36500');
  return { retentionDays, scanIntervalMs: 15_000, retentionIntervalMs: 60 * 60_000, settleMs: 60_000,
    backfillMs: 3 * 86_400_000, batchSize: 100, maxBatchesPerRun: 10, retentionBatchSize: 1000, maxRetentionBatches: 20 };
}

export interface InboxScanResult {
  source: string; scanned: number; created: number; skipped?: 'locked' | 'missing-table';
  /** Rows passed without a notification because the inbox refuses them (logged). */
  parked?: number;
  /** The source failed this run (logged; retried on a later wake). */
  failed?: boolean;
}

/**
 * Turns committed business rows into notifications, driven by the Jobs host (wake source
 * `inbox-events`, no private timer). Per source and batch, one transaction: lock the cursor row
 * `FOR UPDATE SKIP LOCKED` (a replica holding it makes the others skip), read up to `batchSize`
 * rows after it, emit, then advance the cursor. A crash before commit rolls back both inserts and
 * cursor; the rescan re-emits under the same `eventKey`, so nothing is duplicated or lost.
 */
@Injectable()
export class InboxEventScanner implements OnModuleInit {
  private readonly logger = new Logger(InboxEventScanner.name);
  private readonly warned = new Set<string>();
  private lastScanAt = 0;
  private lastRetentionAt = 0;
  private running = false;

  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, private readonly inbox: InboxService,
    @Inject(INBOX_OPTIONS) private readonly options: InboxOptions, @Optional() private readonly jobs?: JobsService,
    @Optional() @Inject(INBOX_SOURCES_TOKEN) private readonly sources: readonly InboxSource[] = INBOX_SOURCES) {}

  onModuleInit(): void {
    this.jobs?.registerWakeSource({ name: INBOX_WAKE_SOURCE, runOnce: () => this.tick() });
  }

  /** Throttled entry point for the Jobs host; failures are logged and retried on a later wake. */
  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (now - this.lastScanAt >= this.options.scanIntervalMs) {
        this.lastScanAt = now;
        await this.scanAll();
      }
      if (this.options.retentionDays > 0 && now - this.lastRetentionAt >= this.options.retentionIntervalMs) {
        this.lastRetentionAt = now;
        await this.purge(new Date(now));
      }
    } catch (error) {
      this.logger.warn(`Inbox event scan failed: ${error instanceof Error ? error.name : 'error'}; retrying on a later wake`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Every source runs in isolation: a failing source (database error, bug) is logged and retried on a
   * later wake, and the sources after it still run. Poison rows never reach this level (see scanBatch).
   */
  async scanAll(): Promise<InboxScanResult[]> {
    const results: InboxScanResult[] = [];
    for (const source of this.sources) {
      let total: InboxScanResult = { source: source.name, scanned: 0, created: 0 };
      try {
        for (let batch = 0; batch < this.options.maxBatchesPerRun; batch += 1) {
          const result = await this.scanBatch(source);
          total = { ...total, scanned: total.scanned + result.scanned, created: total.created + result.created,
            ...(result.skipped ? { skipped: result.skipped } : {}), ...(result.parked ? { parked: (total.parked ?? 0) + result.parked } : {}) };
          if (result.skipped || result.scanned < this.options.batchSize) break;
        }
      } catch (error) {
        total = { ...total, failed: true };
        this.logger.warn(`Inbox source ${source.name} failed (${error instanceof Error ? error.name : 'error'}); retrying on a later wake`);
      }
      results.push(total);
    }
    return results;
  }

  /** One locked batch of one source. Exposed for tests (crash/race scenarios). */
  async scanBatch(source: InboxSource): Promise<InboxScanResult> {
    return this.database.transaction(async tx => {
      if (!await this.tablesExist(tx, source)) return { source: source.name, scanned: 0, created: 0, skipped: 'missing-table' as const };
      const cursor = await this.lockCursor(tx, source.name);
      if (!cursor) return { source: source.name, scanned: 0, created: 0, skipped: 'locked' as const };
      const clock = await tx.query<{ now: Date | string }>('SELECT now() AS now');
      const settledBefore = new Date(new Date(clock.rows[0].now).getTime() - this.options.settleMs);
      const events = await source.scan(tx, cursor, this.options.batchSize, settledBefore);
      let created = 0, parked = 0;
      for (const event of events) {
        if (!event.notification) continue;
        try {
          if ((await this.inbox.emit(tx, event.notification)).created) created += 1;
        } catch (error) {
          // A row the inbox can never accept (validation runs before any SQL, so the transaction is
          // intact) is parked: logged without its content and passed by the cursor, so it cannot
          // block the rows behind it. Other errors roll the batch back and retry.
          if (!(error instanceof InboxEmitError)) throw error;
          parked += 1;
          this.logger.warn(`Inbox source ${source.name} skipped row ${event.cursor.id}: ${error.message.slice(0, 200)}`);
        }
      }
      const last = events.at(-1);
      if (last) await tx.query(`UPDATE inbox_cursors SET "cursorAt" = $2::timestamptz, "cursorId" = $3, "updatedAt" = now() WHERE source = $1`,
        [source.name, last.cursor.at.toISOString(), last.cursor.id]);
      return { source: source.name, scanned: events.length, created, ...(parked ? { parked } : {}) };
    });
  }

  /** Deletes read or archived notifications older than the retention window, in bounded batches. */
  async purge(now = new Date()): Promise<number> {
    if (this.options.retentionDays <= 0) return 0;
    const cutoff = new Date(now.getTime() - this.options.retentionDays * 86_400_000).toISOString();
    let deleted = 0;
    for (let batch = 0; batch < this.options.maxRetentionBatches; batch += 1) {
      const result = await this.database.transaction(tx => tx.query<{ id: string }>(`
        DELETE FROM inbox_notifications WHERE id IN (
          SELECT id FROM inbox_notifications WHERE ("isRead" OR "isArchived") AND "createdAt" < $1::timestamptz
          LIMIT ${Math.trunc(this.options.retentionBatchSize)})
        RETURNING id`, [cutoff]));
      deleted += result.rows.length;
      if (result.rows.length < this.options.retentionBatchSize) break;
    }
    return deleted;
  }

  private async tablesExist(tx: ApplicationTransaction, source: InboxSource): Promise<boolean> {
    const result = await tx.query<{ missing: string | null }>(
      'SELECT name AS missing FROM unnest($1::text[]) AS name WHERE to_regclass(quote_ident(name)) IS NULL LIMIT 1', [source.tables]);
    if (!result.rows.length) return true;
    if (!this.warned.has(source.name)) {
      this.warned.add(source.name);
      this.logger.warn(`Inbox source ${source.name} skipped: table ${result.rows[0].missing} does not exist`);
    }
    return false;
  }

  private async lockCursor(tx: ApplicationTransaction, name: string): Promise<InboxCursor | null> {
    await tx.query(`INSERT INTO inbox_cursors (source, "cursorAt", "cursorId") VALUES ($1, now() - ($2::double precision * interval '1 millisecond'), '')
      ON CONFLICT (source) DO NOTHING`, [name, this.options.backfillMs]);
    const result = await tx.query<{ cursorAt: Date | string; cursorId: string }>(
      'SELECT "cursorAt", "cursorId" FROM inbox_cursors WHERE source = $1 FOR UPDATE SKIP LOCKED', [name]);
    const row = result.rows[0];
    return row ? { at: new Date(row.cursorAt), id: row.cursorId } : null;
  }
}
