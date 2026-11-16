/**
 * Opt-in adapters onto other framework packages (optional peers `@zucker-framework/credit` and
 * `@zucker-framework/storage`). The root entry never imports this file.
 */
import { BatchCreditInsufficientError, type BatchCreditLedger } from '@zucker-framework/credit';
import { transferVerifiedObject, type BufferedObjectStore } from '@zucker-framework/storage';
import { AITaskInsufficientCreditsError } from './errors';
import { AI_OUTPUT_EXTENSIONS, sniffMediaType } from './media-content';
import type { CreditHoldPort, OutputStorePort } from './ports';

export interface LedgerCreditHoldPortOptions<Tx> {
  ledger: Pick<BatchCreditLedger<Tx>, 'hold' | 'confirmHold' | 'releaseHold'>;
  /**
   * Lot ids the hold may draw from (owned, unexpired, with remainder). The ledger allocates them in
   * its configured consume order (e.g. expiry-first). An empty list means no spendable credit.
   */
  spendableLotIds(tx: Tx, ownerId: string): Promise<readonly string[]>;
  /** Journal fields for each movement (type, description, references). Consumer policy. */
  transactionData(phase: 'hold' | 'confirm' | 'release', input: { taskId: string; ownerId: string; amount?: number }): Record<string, unknown>;
  /** Hold resource type recorded on the ledger hold, default 'ai-task'. */
  resourceType?: string;
}

/** Maps `BatchCreditLedger` wallet holds onto CreditHoldPort; insufficient credit becomes AITaskInsufficientCreditsError. */
export function createLedgerCreditHoldPort<Tx>(options: LedgerCreditHoldPortOptions<Tx>): CreditHoldPort<Tx> {
  return {
    async place(tx, input) {
      const lotIds = await options.spendableLotIds(tx, input.ownerId);
      if (!lotIds.length) throw new AITaskInsufficientCreditsError(input.amount, 0);
      try {
        await options.ledger.hold(tx, {
          id: input.holdId, accountId: input.ownerId, amount: input.amount, lotIds,
          resourceType: options.resourceType ?? 'ai-task', resourceId: input.taskId, operationKey: input.operationKey,
          transactionData: options.transactionData('hold', { taskId: input.taskId, ownerId: input.ownerId, amount: input.amount }),
        });
      } catch (error) {
        if (error instanceof BatchCreditInsufficientError) throw new AITaskInsufficientCreditsError(error.required, error.available);
        throw error;
      }
    },
    async confirm(tx, input) {
      await options.ledger.confirmHold(tx, {
        id: input.holdId, accountId: input.ownerId, operationKey: input.operationKey,
        transactionData: options.transactionData('confirm', { taskId: input.taskId, ownerId: input.ownerId }),
      });
    },
    async release(tx, input) {
      // Replays of the same operation key are no-ops in the ledger; an opposite decision is a conflict.
      await options.ledger.releaseHold(tx, {
        id: input.holdId, accountId: input.ownerId, operationKey: input.operationKey,
        transactionData: options.transactionData('release', { taskId: input.taskId, ownerId: input.ownerId }),
      });
    },
  };
}

export interface VerifiedOutputStoreOptions {
  store: BufferedObjectStore;
  /** Key prefix, default 'ai-tasks'. Keys are `<prefix>/<taskId>/<index>.<ext>` (deterministic, so retries reuse). */
  prefix?: string;
}

/**
 * OutputStorePort on top of storage's `transferVerifiedObject`: writes privately, round-trips the
 * upload (size, sniffed MIME, SHA-256) and reuses an identical existing object on retry.
 */
export function createVerifiedOutputStore(options: VerifiedOutputStoreOptions): OutputStorePort {
  const prefix = (options.prefix ?? 'ai-tasks').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,100}$/.test(prefix)) throw new RangeError('Invalid output key prefix');
  return {
    async put(output) {
      output.signal.throwIfAborted();
      const extension = AI_OUTPUT_EXTENSIONS[output.contentType];
      if (!extension || !/^ait_[a-f0-9]{64}$/.test(output.taskId)) throw new RangeError('Unsupported AI task output');
      const destinationKey = `${prefix}/${output.taskId}/${output.index}.${extension}`;
      const result = await transferVerifiedObject({
        source: { body: output.body, reportedSize: output.body.length },
        // The legacy buffered store has no cancellation API. Fence every subsequent operation so
        // an exists/read that finishes after the deadline cannot start a new remote upload.
        target: {
          async exists(key) { output.signal.throwIfAborted(); const value = await options.store.exists(key); output.signal.throwIfAborted(); return value; },
          async read(key) { output.signal.throwIfAborted(); const value = await options.store.read(key); output.signal.throwIfAborted(); return value; },
          async write(key, body, metadata) { output.signal.throwIfAborted(); const value = await options.store.write(key, body, metadata); output.signal.throwIfAborted(); return value; },
        },
        destinationKey,
        mode: 'apply',
        allowUpload: true,
        detectMimeType: (body) => sniffMediaType(body) ?? 'application/octet-stream',
      });
      if (result.sha256 !== output.sha256 || result.mimeType !== output.contentType) throw new Error('Stored output does not match the download');
      return { storageKey: destinationKey };
    },
  };
}
