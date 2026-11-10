import { AITaskInsufficientCreditsError, type CreditHoldPort } from '@zucker-framework/ai-tasks';
import { createLedgerCreditHoldPort } from '@zucker-framework/ai-tasks/adapters';
import { BatchCreditInsufficientError, type BatchCreditLedger } from '@zucker-framework/credit';
import { createCreditLedger } from '../billing/ledger';
import { readRefundCreditBlocks } from '../credits/refund-credit-blocks';
import type { ApplicationDatabase, ApplicationTransaction } from '../database';

/**
 * Lots a new AI hold may draw from: owned, unexpired, with a remainder, and not blocked by a confirmed
 * refund awaiting recovery (the application ledger refuses a hold that selects such a lot). The
 * ledger allocates them in its configured order (expiry first) and subtracts other active holds.
 */
export async function spendableLotIds(tx: ApplicationTransaction, ownerId: string, now = new Date()): Promise<string[]> {
  const rows = (await tx.query<{ id: string }>(
    `SELECT id FROM credit_lots WHERE "userId"=$1 AND NOT "isExpired" AND "remainingAmount">0
       AND ("expiresAt" IS NULL OR "expiresAt">$2)`, [ownerId, now])).rows;
  if (!rows.length) return [];
  const blocked = await readRefundCreditBlocks(tx, ownerId, now);
  return rows.map(row => row.id).filter(id => !blocked.has(id));
}

/** Available (unheld) wallet balance; `credit_account.balance` already excludes active holds. */
export async function availableCredits(tx: ApplicationTransaction, ownerId: string): Promise<number> {
  const row = (await tx.query<{ balance: number }>('SELECT balance FROM credit_account WHERE "userId"=$1', [ownerId])).rows[0];
  return row ? Math.max(0, Number(row.balance)) : 0;
}

/** `CreditHoldPort` for AI media tasks on the application's canonical ledger (FREEZE / CONSUME / UNFREEZE journal). */
export function createAITaskHoldPort(database: ApplicationDatabase): CreditHoldPort<ApplicationTransaction> {
  return createLedgerCreditHoldPort<ApplicationTransaction>({
    ledger: createCreditLedger(database),
    spendableLotIds: (tx, ownerId) => spendableLotIds(tx, ownerId),
    transactionData: (phase, input) => ({
      type: phase === 'hold' ? 'FREEZE' : phase === 'confirm' ? 'CONSUME' : 'UNFREEZE',
      description: phase === 'hold' ? 'AI generation (held)' : phase === 'confirm' ? 'AI generation' : 'AI generation refunded',
      metadata: { resourceType: 'ai-task', resourceId: input.taskId },
    }),
  });
}

/**
 * Chat metering on the same ledger. A turn holds `minimum` before streaming; settlement releases the
 * hold and consumes the actual cost in the same transaction (the ledger has no partial confirm), so
 * the net journal effect is "charge actual, return the rest". Everything runs on the caller's
 * transaction under the ledger's account lock.
 */
export class ChatCreditLedger {
  private readonly ledger: BatchCreditLedger<ApplicationTransaction>;
  constructor(database: ApplicationDatabase) { this.ledger = createCreditLedger(database); }

  async hold(tx: ApplicationTransaction, input: { holdId: string; ownerId: string; amount: number; messageId: string }): Promise<void> {
    const lotIds = await spendableLotIds(tx, input.ownerId);
    if (!lotIds.length) throw new AITaskInsufficientCreditsError(input.amount, 0);
    try {
      await this.ledger.hold(tx, { id: input.holdId, accountId: input.ownerId, amount: input.amount, lotIds,
        resourceType: 'chat-message', resourceId: input.messageId, operationKey: `chat:${input.messageId}:hold`,
        transactionData: { type: 'FREEZE', description: 'AI chat (held)', metadata: { resourceType: 'chat-message', resourceId: input.messageId } } });
    } catch (error) {
      if (error instanceof BatchCreditInsufficientError) throw new AITaskInsufficientCreditsError(error.required, error.available);
      throw error;
    }
  }

  /**
   * Releases the hold (when any) and consumes `cost`. When the wallet cannot cover a cost above the
   * hold (lots expired mid-stream, or usage beyond the affordable estimate), it charges what remains
   * spendable and never goes negative. Returns the amount actually charged.
   */
  async settle(tx: ApplicationTransaction, input: { holdId: string | null; ownerId: string; messageId: string; cost: number }): Promise<number> {
    if (input.holdId) await this.ledger.releaseHold(tx, { id: input.holdId, accountId: input.ownerId, operationKey: `chat:${input.messageId}:release`,
      transactionData: { type: 'UNFREEZE', description: 'AI chat hold returned', metadata: { resourceType: 'chat-message', resourceId: input.messageId } } });
    if (input.cost <= 0) return 0;
    const consume = (amount: number) => this.ledger.consume(tx, { accountId: input.ownerId, amount,
      transactionData: { type: 'CONSUME', description: 'AI chat', metadata: { resourceType: 'chat-message', resourceId: input.messageId } },
      consumptionData: { resourceType: 'chat-message', resourceId: input.messageId } });
    try {
      await consume(input.cost);
      return input.cost;
    } catch (error) {
      if (!(error instanceof BatchCreditInsufficientError)) throw error;
      const available = Math.min(input.cost, Math.max(0, error.available));
      if (available > 0) await consume(available);
      return available;
    }
  }
}
