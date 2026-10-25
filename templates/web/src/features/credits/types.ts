export interface CreditBalance { available: number; frozen: number; refundBlocked: number; expired: number; bookBalance: number; pendingExpiry: number; asOf: string }
export interface CreditTransaction { id: string; type: string; amount: number; balance: number; balanceBefore: number | null; balanceAfter: number | null;
  ledgerIds: string[]; description: string | null; orderId: string | null; createdAt: string; references: Record<string, string>;
  frozenBalanceBefore?: number | null; frozenBalanceAfter?: number | null }
export interface CreditLot { id: string; source: string; sourceId: string | null; amount: number; remainingAmount: number; availableAmount: number;
  status: 'available' | 'consumed' | 'expired' | 'held' | 'refund_pending'; frozenAmount?: number; refundBlockedAmount: number; expiresAt: string | null; description: string | null; createdAt: string }
export interface CreditPage<T> { data: T[]; total: number; page: number; pageSize: number }
export const creditTypes = ['GRANT', 'CONSUME', 'REFUND', 'EXPIRE', 'TRANSFER_IN', 'TRANSFER_OUT', 'FREEZE', 'UNFREEZE'] as const;
