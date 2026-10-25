import { CreditLotHoldError } from '@zucker-framework/credit';
import type { ApplicationTransaction } from '../database';

export class RefundCreditBlockedError extends CreditLotHoldError {
  constructor() {
    super('conflict', 'Credits from a confirmed refund are awaiting reconciliation');
    this.name = 'RefundCreditBlockedError';
  }
}

/** Call under the same account lock used for cash evidence and ledger mutations. */
export async function readRefundCreditBlocks(
  tx: ApplicationTransaction,
  ownerId: string,
  now = new Date(),
): Promise<Map<string, number>> {
  const result = await tx.query<{ id: string; remainingAmount: number; held: string }>(
    `
    SELECT lot.id,lot."remainingAmount",COALESCE((SELECT SUM(allocation."activeAmount")
      FROM credit_hold_allocations AS allocation JOIN credit_holds AS hold ON hold.id=allocation."holdId"
      WHERE allocation."creditLotId"=lot.id AND hold."accountId"=$1),0)::text AS held
    FROM credit_lots AS lot
    WHERE lot."userId"=$1 AND NOT lot."isExpired" AND lot."remainingAmount">0
      AND (lot."expiresAt" IS NULL OR lot."expiresAt">$2)
      AND EXISTS (SELECT 1 FROM billing_refund_payments AS payment
        WHERE payment."ownerId"=$1 AND payment."grantSource"=lot.source AND payment."grantSourceId"=lot."sourceId"
          AND (FLOOR(payment."totalCredits"::numeric*payment."refundedMinor"::numeric/payment."paidMinor"::numeric)>payment."recoveredCredits"
            OR EXISTS (SELECT 1 FROM billing_refund_events AS event
              WHERE event."providerId"=payment."providerId" AND event."accountScope"=payment."accountScope"
                AND event."sourceKind"=payment."sourceKind" AND event."sourceId"=payment."sourceId"
                AND event.status<>'processed' AND event.evidence->>'state'='succeeded')))
  `,
    [ownerId, now],
  );
  return new Map(
    result.rows.map((row) => {
      const held = Number(row.held);
      if (!Number.isSafeInteger(held) || held < 0 || held > row.remainingAmount)
        throw new CreditLotHoldError(
          'invariant',
          'Refund-blocked credit allocations require reconciliation',
        );
      return [row.id, row.remainingAmount - held];
    }),
  );
}
