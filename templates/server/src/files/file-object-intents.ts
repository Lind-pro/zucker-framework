import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import { FILE_MANAGER, type FileManager } from '@zucker-framework/storage';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { JobsService } from '../jobs/jobs.service';
import { DEFAULT_ORPHAN_GRACE_MINUTES, FILES_OPTIONS, type FilesOptions } from './files.config';

export type FileObjectIntentKind = 'generated' | 'public-asset';
export const FILE_ORPHANS_WAKE_SOURCE = 'file-orphans';
/** Intents examined per sweep; each is settled in its own short transaction. */
export const ORPHAN_SWEEP_BATCH = 50;
/** Wake sources run every Jobs scan; the sweep itself runs at most this often per process. */
export const ORPHAN_SWEEP_INTERVAL_MS = 60_000;
/** Only server-generated keys are ever recorded (mirrors the table's CHECK constraint). */
const INTENT_KEYS: Readonly<Record<FileObjectIntentKind, RegExp>> = {
  generated: /^private-assets\/[0-9a-f-]{36}$/,
  'public-asset': /^public-assets\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/,
};

/** The sweeper removed this intent (and its object) before the file row could be recorded. */
export class FileObjectIntentLostError extends Error {
  constructor() { super('Object intent expired before the file was recorded'); this.name = 'FileObjectIntentLostError'; }
}

export function graceMilliseconds(options: Pick<FilesOptions, 'orphanGraceMinutes'>): number {
  return (options.orphanGraceMinutes ?? DEFAULT_ORPHAN_GRACE_MINUTES) * 60_000;
}

/**
 * Write-ahead intents for objects uploaded before their file row exists. Opening an intent precedes
 * the first uploaded byte; `settle` runs inside the transaction that records the row; `close` runs
 * after an unrecorded object was deleted. Anything left behind by a crash is reclaimed by the sweeper.
 */
export class FileObjectIntents {
  constructor(private readonly database: ApplicationDatabase) {}

  async open(ownerId: string, objectKey: string, kind: FileObjectIntentKind, now = new Date()): Promise<void> {
    if (!INTENT_KEYS[kind].test(objectKey)) throw new Error('Invalid object intent key');
    await this.database.transaction(tx => tx.query(
      'INSERT INTO file_object_intents ("objectKey","ownerId","kind","createdAt") VALUES ($1,$2,$3,$4)', [objectKey, ownerId, kind, now]));
  }

  /** Restarts the grace period of a long upload; false when the sweeper already reclaimed the key. */
  async touch(objectKey: string, now = new Date()): Promise<boolean> {
    const result = await this.database.transaction(tx => tx.query<{ objectKey: string }>(
      'UPDATE file_object_intents SET "createdAt"=$2 WHERE "objectKey"=$1 RETURNING "objectKey"', [objectKey, now]));
    return result.rows.length === 1;
  }

  /**
   * Inside the recording transaction: locks the intent (waiting for a sweeper that holds it) and fails
   * when it is gone, so a row is never recorded for an object the sweeper deleted. Call before the insert.
   */
  static async lock(tx: ApplicationTransaction, objectKey: string): Promise<void> {
    const locked = await tx.query('SELECT 1 FROM file_object_intents WHERE "objectKey"=$1 FOR UPDATE', [objectKey]);
    if (!locked.rows.length) throw new FileObjectIntentLostError();
  }

  /** Inside the recording transaction, after the row referencing the key was inserted. */
  static async settle(tx: ApplicationTransaction, objectKey: string): Promise<void> {
    await tx.query('DELETE FROM file_object_intents WHERE "objectKey"=$1', [objectKey]);
  }

  /** After the unrecorded object was deleted (or never written). */
  async close(objectKey: string): Promise<void> {
    await this.database.transaction(tx => tx.query('DELETE FROM file_object_intents WHERE "objectKey"=$1', [objectKey]));
  }
}

export interface OrphanSweepResult { deleted: number; released: number; skipped: number; failed: number }

/**
 * Wake source `file-orphans`: for each intent older than the grace period, deletes the object when no
 * `file_assets`/`public_assets` row references its key (a missing object counts as deleted), then the
 * intent; a referenced key only loses its intent. Each intent is locked with SKIP LOCKED and its
 * references re-checked in the transaction that removes it, so concurrent sweepers never double-handle a
 * key and a recording transaction (which locks the intent first) either wins or fails cleanly.
 */
@Injectable()
export class FileOrphanSweeper implements OnModuleInit {
  private readonly logger = new Logger(FileOrphanSweeper.name);
  private nextRunAt = 0;
  private running = false;
  constructor(@Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase, @Inject(FILE_MANAGER) private readonly manager: FileManager,
    @Inject(FILES_OPTIONS) private readonly options: FilesOptions, @Optional() private readonly jobs?: JobsService) {}

  onModuleInit(): void {
    this.jobs?.registerWakeSource({ name: FILE_ORPHANS_WAKE_SOURCE, runOnce: async () => { await this.runIfDue(); } });
  }

  async runIfDue(now = Date.now()): Promise<OrphanSweepResult | null> {
    if (this.running || now < this.nextRunAt) return null;
    this.running = true;
    this.nextRunAt = now + ORPHAN_SWEEP_INTERVAL_MS;
    try { return await this.sweep(new Date(now)); }
    finally { this.running = false; }
  }

  async sweep(now = new Date()): Promise<OrphanSweepResult> {
    const cutoff = new Date(now.getTime() - graceMilliseconds(this.options));
    const result: OrphanSweepResult = { deleted: 0, released: 0, skipped: 0, failed: 0 };
    const candidates = await this.database.transaction(tx => tx.query<{ objectKey: string }>(
      `SELECT "objectKey" FROM file_object_intents WHERE "createdAt" < $1 ORDER BY "createdAt", "objectKey" LIMIT ${ORPHAN_SWEEP_BATCH}`, [cutoff]));
    for (const { objectKey } of candidates.rows) {
      try { result[await this.settle(objectKey, cutoff)] += 1; }
      catch {
        result.failed += 1;
        // The key is a server UUID/content hash; keep the log free of owner data.
        this.logger.warn('file_orphan_sweep_failed');
      }
    }
    if (result.deleted || result.failed) this.logger.log(`file_orphan_sweep deleted=${result.deleted} released=${result.released} failed=${result.failed}`);
    return result;
  }

  private settle(objectKey: string, cutoff: Date): Promise<'deleted' | 'released' | 'skipped'> {
    return this.database.transaction(async tx => {
      const locked = await tx.query<{ kind: FileObjectIntentKind }>(
        'SELECT "kind" FROM file_object_intents WHERE "objectKey"=$1 AND "createdAt" < $2 FOR UPDATE SKIP LOCKED', [objectKey, cutoff]);
      const intent = locked.rows[0];
      // Taken by another sweeper or a recording transaction, refreshed by a running upload, or already gone.
      if (!intent) return 'skipped';
      const referenced = await tx.query(
        'SELECT 1 FROM file_assets WHERE "objectKey"=$1 UNION ALL SELECT 1 FROM public_assets WHERE "objectKey"=$1 LIMIT 1', [objectKey]);
      let outcome: 'deleted' | 'released' = 'released';
      if (!referenced.rows.length) {
        if (!INTENT_KEYS[intent.kind]?.test(objectKey)) throw new Error('Refusing to delete an unexpected object key');
        // Object IO under this one intent's row lock only: a failure rolls back and leaves the intent for the next sweep.
        await this.deleteObject(objectKey);
        outcome = 'deleted';
      }
      await tx.query('DELETE FROM file_object_intents WHERE "objectKey"=$1', [objectKey]);
      return outcome;
    });
  }

  private async deleteObject(objectKey: string): Promise<void> {
    try { await this.manager.delete(objectKey); }
    catch (error) {
      // A provider that reports a missing object as an error: absent is the goal.
      if (await this.manager.exists(objectKey).catch(() => true)) throw error;
    }
  }
}
