import type { DatabaseAdapter } from '@zucker-framework/core';

/** A transaction that also runs fixed, parameterised SQL (template `ApplicationTransaction`, or any adapter with `query`). */
export interface ManagementSqlTransaction extends DatabaseAdapter {
  query<TRow = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}

/** Payment identity of one order row, handed to the refund summary port (never returned to the client). */
export interface ManagementRefundOrder {
  id: string;
  ownerId: string;
  providerId: string;
  accountScope: string;
  paymentId: string | null;
  paymentKind: 'payment-intent' | 'invoice' | 'capture' | 'transaction' | null;
}
/** Billing-owned refund state of an order (shape rendered by fe-admin `records.refundSummary`). */
export interface ManagementRefundSummaryPort {
  summarize(order: ManagementRefundOrder): Promise<unknown>;
}

/** Read side of the credit ledger for `GET <path>/credits/:ownerId/{balance,lots}`. */
export interface ManagementCreditsPort {
  balance(ownerId: string): Promise<unknown>;
  lots(ownerId: string, query: Record<string, unknown>): Promise<unknown>;
}

export interface ManagementCreditGrant {
  accountId: string;
  amount: number;
  source: 'admin';
  sourceId: string;
  expiresAt?: Date;
  description: string;
  transactionData: {
    type: 'GRANT';
    description: string;
    expireAt: Date | null;
    metadata: { source: 'admin'; sourceId: string; actorId: string; fingerprint: string };
  };
}
/** Write side of the credit ledger; runs inside the grant transaction after the operation claim. */
export interface ManagementCreditLedgerPort {
  grant(tx: ManagementSqlTransaction, grant: ManagementCreditGrant): Promise<unknown>;
}

/** Connection inventory for `GET <path>/connections` (consumer-owned; secrets never leave it). */
export interface ManagementConnectionsPort {
  inspect(): Promise<unknown> | unknown;
}

export function assertSqlTransaction(tx: DatabaseAdapter): ManagementSqlTransaction {
  if (typeof (tx as Partial<ManagementSqlTransaction>).query !== 'function')
    throw new Error('[back-office/management] this feature needs a database adapter whose transactions expose query(sql, values)');
  return tx as ManagementSqlTransaction;
}
