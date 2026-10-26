export interface RefundMoney {
  amount: string;
  currency: string;
}
export type RefundTargetType = 'order' | 'cycle';
export type RefundState =
  | 'prepared'
  | 'submitting'
  | 'pending'
  | 'requires_action'
  | 'unknown'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'attention';
export interface RefundView {
  id: string;
  targetType: RefundTargetType;
  targetId: string;
  ownerId?: string;
  orderId: string;
  cycleId?: string | null;
  title: string;
  money: RefundMoney;
  reason: string | null;
  state: RefundState;
  cashState: string;
  reconcileStatus: 'idle' | 'pending' | 'attention';
  confirmationBasis?: 'receipt' | 'payment_total' | null;
  creditState: 'held' | 'settled' | 'released' | 'suppressed' | 'attention';
  creditImpact: {
    held: number;
    revoked: number;
    expired: number;
    suppressed: number;
    shortfall: number;
  };
  createdAt: string;
  updatedAt: string;
  canCheck: boolean;
}
export interface RefundTarget {
  targetType: RefundTargetType;
  targetId: string;
  ownerId?: string;
  orderId: string;
  cycleId?: string | null;
  title: string;
  paidMoney: RefundMoney;
  refundedMoney: RefundMoney;
  pendingMoney: RefundMoney;
  remainingMoney: RefundMoney;
  totalCredits: number;
  recoveredCredits: number;
  activeRequestId?: string | null;
  attention: boolean;
  cashEvidencePending: boolean;
  capabilities: { partial: boolean; canCreate: boolean; canCheck: boolean };
}
export interface RefundCycle {
  id: string;
  paidMoney: RefundMoney;
  paidAt: string;
  period: { start: string; end: string } | null;
  initial: boolean;
}
export interface RefundPage<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}
export const refundStates: Record<RefundState, string> = {
  prepared: '已记录',
  submitting: '提交中',
  pending: '处理中',
  requires_action: '需要处理',
  unknown: '待核对',
  succeeded: '已完成',
  failed: '已失败',
  canceled: '已取消',
  attention: '需要人工处理',
};
export const creditStates: Record<RefundView['creditState'], string> = {
  held: '额度已保留',
  settled: '额度处理完成',
  released: '额度已恢复',
  suppressed: '未发额度已阻止',
  attention: '额度需要处理',
};
export const moneyText = (money: RefundMoney) => `${money.amount} ${money.currency}`;

/** Canonical decimal spelling for an intent hash; never round or use floating-point arithmetic. */
export function canonicalRefundAmount(value: string): string {
  const amount = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(amount) || !/[1-9]/.test(amount))
    throw new Error('Invalid refund amount');
  const [whole, fraction = ''] = amount.split('.'),
    decimals = fraction.replace(/0+$/, '');
  return `${whole!.replace(/^0+(?=\d)/, '')}${decimals ? `.${decimals}` : ''}`;
}
