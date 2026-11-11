import type { Money, HostedCheckoutPaymentKind, RefundPaymentReference } from '@zucker-framework/payment';
export type RefundTargetType = 'order' | 'cycle';
export type RefundRequestState = 'prepared' | 'submitting' | 'pending' | 'requires_action' | 'unknown' | 'succeeded' | 'failed' | 'canceled' | 'attention';
export interface RefundTargetRow {
  id: string; ownerId: string; orderId: string; cycleId: string | null; providerId: string; accountScope: string;
  paymentKind: HostedCheckoutPaymentKind; paymentId: string; sourceKind: string; sourceId: string; title: string;
  paidMoney: Money; paidMinor: string; minorScale: number; totalCredits: number; refundedMinor: string;
  providerPendingMinor: string | null; recoveredCredits: number; revokedCredits: number; expiredCredits: number;
  suppressedCredits: number; grantRecorded: boolean; grantSource: string | null; grantSourceId: string | null;
  activeRequestId: string | null; attention: boolean; revision: number; observedAt: Date; createdAt: Date; updatedAt: Date;
}
export interface RefundRequestRow {
  id: string; targetId: string; ownerId: string; actorId: string; clientKey: string; commandKey: string;
  requestedMinor: string; beforeRefundedMinor: string; expectedRefundedMinor: string; money: Money; reason: string | null;
  state: RefundRequestState; creditState: 'held' | 'settled' | 'released' | 'suppressed' | 'attention'; creditAmount: number;
  holdId: string | null; expiredCredits: number; suppressedCredits: number; revokedCredits: number; shortfallCredits: number;
  providerRefundId: string | null; confirmationBasis: string | null; checkedAt: Date | null; revision: number;
  lastReconcileTaskId: string | null; reconcileStatus: 'idle' | 'pending' | 'attention'; reconcileErrorCode: string | null;
  createdAt: Date; updatedAt: Date;
}
export interface RefundLocalPayment {
  ownerId: string; orderId: string; cycleId?: string; providerId: string; accountScope: string; title: string;
  reference: RefundPaymentReference; totalCredits: number; grantRecorded: boolean;
  /** True when the payment was a plan sale (its frozen fulfillment data carries a `plan` snapshot). */
  plan?: boolean;
  grantSource?: 'purchase' | 'subscription'; grantSourceId?: string;
}
