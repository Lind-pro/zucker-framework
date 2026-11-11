import { BadRequestException } from '@nestjs/common';
import type { ManagementModelKey } from './management.options';

/**
 * Read-only projections (route name → logical model, owner/status/time fields and the selected
 * columns). These are the field lists fe-admin `recordDefinitions` render; persisted logs are not
 * here, they use the shared log record contract of `@zucker-framework/admin`.
 */
export interface ManagementRecordDefinition {
  model: ManagementModelKey;
  owner: string | null;
  status: string | null;
  time: string;
  fields: readonly string[];
  statuses?: readonly string[];
}

export const MANAGEMENT_RECORDS = {
  'api-keys': {
    model: 'apiKeys', owner: 'userId', status: null, time: 'createdAt',
    fields: ['id', 'userId', 'name', 'keyPrefix', 'scopes', 'isActive', 'revokedAt', 'expiresAt', 'lastUsedAt', 'createdAt'],
    statuses: ['active', 'revoked', 'expired', 'disabled'],
  },
  orders: {
    model: 'orders', owner: 'ownerId', status: 'state', time: 'createdAt',
    fields: ['id', 'ownerId', 'offerId', 'providerId', 'state', 'creationState', 'captureState', 'paymentKind', 'fulfilledAt', 'createdAt', 'updatedAt'],
    statuses: ['unknown', 'pending', 'requires_capture', 'paid', 'unpaid'],
  },
  subscriptions: {
    model: 'billingSubscriptions', owner: 'ownerId', status: 'status', time: 'createdAt',
    fields: ['id', 'ownerId', 'initialOrderId', 'providerId', 'status', 'providerStatus', 'grantBasis', 'initialFulfilledAt', 'cancelState',
      'cancelAtPeriodEnd', 'currentPeriodStart', 'currentPeriodEnd', 'observedAt', 'createdAt'],
    statuses: ['unknown', 'active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled'],
  },
  jobs: {
    model: 'jobs', owner: 'userId', status: 'status', time: 'createdAt',
    fields: ['id', 'userId', 'kind', 'resourceType', 'resourceId', 'status', 'stage', 'progress', 'attempt', 'maxAttempts', 'errorCode',
      'errorRetryable', 'createdAt', 'completedAt'],
    statuses: ['QUEUED', 'PROCESSING', 'WAITING_PROVIDER', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  },
  deliveries: {
    model: 'deliveries', owner: null, status: 'status', time: 'createdAt',
    fields: ['id', 'channel', 'status', 'attempt', 'maxAttempts', 'errorCode', 'errorRetryable', 'createdAt', 'deliveredAt', 'failedAt'],
    statuses: ['PENDING', 'PROCESSING', 'RETRYING', 'DELIVERED', 'DEAD'],
  },
  files: {
    model: 'files', owner: 'ownerId', status: 'state', time: 'createdAt',
    fields: ['id', 'ownerId', 'fileName', 'size', 'mimeType', 'state', 'cleanupStatus', 'createdAt', 'updatedAt', 'deletedAt'],
    statuses: ['pending', 'ready', 'deleted'],
  },
  credits: {
    model: 'credits', owner: 'userId', status: 'type', time: 'createdAt',
    fields: ['id', 'userId', 'type', 'amount', 'balanceBefore', 'balanceAfter', 'balance', 'description', 'orderId', 'ledgerIds', 'createdAt'],
    statuses: ['GRANT', 'CONSUME', 'REFUND', 'EXPIRE', 'TRANSFER_IN', 'TRANSFER_OUT', 'FREEZE', 'UNFREEZE'],
  },
} as const satisfies Record<string, ManagementRecordDefinition>;
export type ManagementRecordResource = keyof typeof MANAGEMENT_RECORDS;

/** Rejects non-objects and unknown keys (400). */
export function managementRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new BadRequestException('Unsupported management fields');
  return value as Record<string, unknown>;
}
/** Trimmed single-line text up to `limit`; `required=false` allows `undefined`. */
export function managementText(value: unknown, limit: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f]/.test(value))
    throw new BadRequestException('Invalid management text');
  return value.trim();
}
/** `page` 1–10000 (default 1), `pageSize` 1–100 (default 20). */
export function managementPagination(query: Record<string, unknown>) {
  const page = Number(query.page ?? 1), pageSize = Number(query.pageSize ?? 20);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
    throw new BadRequestException('Invalid management pagination');
  return { page, pageSize };
}

type StoredMoney = { amount: string; currency: string };
type LooseMoney = { amount?: unknown; currency?: unknown };
function storedMoney(value: LooseMoney | undefined): StoredMoney | null {
  return typeof value?.amount === 'string' && typeof value.currency === 'string' ? { amount: value.amount, currency: value.currency } : null;
}
/**
 * `money` = amount actually charged (promotion payable, else the list price); `listMoney` and `discount`
 * are present for orders (discount null without a promotion). Subscriptions keep the recurring list price.
 */
export function orderAmounts(resource: string, list: StoredMoney, promotion: { payable?: LooseMoney; discount?: LooseMoney } | null | undefined) {
  if (resource !== 'orders') return { money: { ...list } };
  const payable = promotion ? storedMoney(promotion.payable) : null, discount = promotion ? storedMoney(promotion.discount) : null;
  if (promotion && (!payable || !discount || payable.currency !== list.currency)) throw new Error('Stored offer is invalid');
  return { money: payable ?? { ...list }, listMoney: { ...list }, discount };
}
