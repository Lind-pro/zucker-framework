import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DATABASE_ADAPTER } from '@zucker-framework/core';
import {
  CreditOperationConflictError,
  PostgresCreditOperationCoordinator,
} from '@zucker-framework/credit';
import { ApplicationDatabase } from '../database';
import { createCreditLedger } from '../billing/ledger';
import { CreditsService, creditPageOptions } from '../credits/credits.service';
import {
  readOrderRefundSummary,
  type RefundSummaryOrder,
} from '../billing/refunds/refunds.projection';

export type ManagementResource =
  | 'orders'
  | 'subscriptions'
  | 'jobs'
  | 'deliveries'
  | 'files'
  | 'access-logs'
  | 'operation-logs'
  | 'credits'
  | 'api-keys';
const resources = {
  'api-keys': {
    model: 'accountApiKeys',
    owner: 'userId',
    status: null,
    time: 'createdAt',
    fields: [
      'id',
      'userId',
      'name',
      'keyPrefix',
      'scopes',
      'isActive',
      'revokedAt',
      'expiresAt',
      'lastUsedAt',
      'createdAt',
    ],
  },
  orders: {
    model: 'billingOrders',
    owner: 'ownerId',
    status: 'state',
    time: 'createdAt',
    fields: [
      'id',
      'ownerId',
      'offerId',
      'providerId',
      'state',
      'creationState',
      'captureState',
      'paymentKind',
      'fulfilledAt',
      'createdAt',
      'updatedAt',
    ],
  },
  subscriptions: {
    model: 'billingSubscriptions',
    owner: 'ownerId',
    status: 'status',
    time: 'createdAt',
    fields: [
      'id',
      'ownerId',
      'initialOrderId',
      'providerId',
      'status',
      'providerStatus',
      'grantBasis',
      'initialFulfilledAt',
      'cancelState',
      'cancelAtPeriodEnd',
      'currentPeriodStart',
      'currentPeriodEnd',
      'observedAt',
      'createdAt',
    ],
  },
  jobs: {
    model: 'AsyncJob',
    owner: 'userId',
    status: 'status',
    time: 'createdAt',
    fields: [
      'id',
      'userId',
      'kind',
      'resourceType',
      'resourceId',
      'status',
      'stage',
      'progress',
      'attempt',
      'maxAttempts',
      'errorCode',
      'errorRetryable',
      'createdAt',
      'completedAt',
    ],
  },
  deliveries: {
    model: 'NotificationDelivery',
    owner: null,
    status: 'status',
    time: 'createdAt',
    fields: [
      'id',
      'channel',
      'status',
      'attempt',
      'maxAttempts',
      'errorCode',
      'errorRetryable',
      'createdAt',
      'deliveredAt',
      'failedAt',
    ],
  },
  files: {
    model: 'fileAssets',
    owner: 'ownerId',
    status: 'state',
    time: 'createdAt',
    fields: [
      'id',
      'ownerId',
      'fileName',
      'size',
      'mimeType',
      'state',
      'cleanupStatus',
      'createdAt',
      'updatedAt',
      'deletedAt',
    ],
  },
  'access-logs': {
    model: 'accessLogs',
    owner: 'userId',
    status: null,
    time: 'requestTime',
    fields: [
      'id',
      'userId',
      'username',
      'module',
      'action',
      'method',
      'requestUrl',
      'requestTime',
      'responseTime',
    ],
  },
  'operation-logs': {
    model: 'operationLogs',
    owner: 'userId',
    status: 'status',
    time: 'createdAt',
    fields: [
      'id',
      'userId',
      'module',
      'action',
      'status',
      'targetId',
      'targetType',
      'method',
      'path',
      'duration',
      'createdAt',
    ],
  },
  credits: {
    model: 'creditTransaction',
    owner: 'userId',
    status: 'type',
    time: 'createdAt',
    fields: [
      'id',
      'userId',
      'type',
      'amount',
      'balanceBefore',
      'balanceAfter',
      'balance',
      'description',
      'orderId',
      'ledgerIds',
      'createdAt',
    ],
  },
} as const;
const statusValues: Partial<Record<ManagementResource, readonly string[]>> = {
  'api-keys': ['active', 'revoked', 'expired', 'disabled'],
  orders: ['unknown', 'pending', 'requires_capture', 'paid', 'unpaid'],
  subscriptions: ['unknown', 'active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled'],
  jobs: [
    'QUEUED',
    'PROCESSING',
    'WAITING_PROVIDER',
    'RETRYING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ],
  deliveries: ['PENDING', 'PROCESSING', 'RETRYING', 'DELIVERED', 'DEAD'],
  files: ['pending', 'ready', 'deleted'],
  'operation-logs': ['SUCCESS', 'FAILED', 'PENDING'],
  credits: [
    'GRANT',
    'CONSUME',
    'REFUND',
    'EXPIRE',
    'TRANSFER_IN',
    'TRANSFER_OUT',
    'FREEZE',
    'UNFREEZE',
  ],
};
function record(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new BadRequestException('Unsupported management fields');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > limit ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new BadRequestException('Invalid management text');
  return value.trim();
}
function pagination(query: Record<string, unknown>) {
  const page = Number(query.page ?? 1),
    pageSize = Number(query.pageSize ?? 20);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new BadRequestException('Invalid management pagination');
  return { page, pageSize };
}

function refundSummaryOrder(row: Record<string, unknown>): RefundSummaryOrder {
  const { id, ownerId, providerId, accountScope, paymentId, paymentKind } = row;
  if (
    typeof id !== 'string' ||
    typeof ownerId !== 'string' ||
    typeof providerId !== 'string' ||
    typeof accountScope !== 'string' ||
    (paymentId !== null && typeof paymentId !== 'string') ||
    (paymentKind !== null &&
      paymentKind !== 'payment-intent' &&
      paymentKind !== 'invoice' &&
      paymentKind !== 'capture' &&
      paymentKind !== 'transaction')
  )
    throw new Error('Stored payment identity is invalid');
  return { id, ownerId, providerId, accountScope, paymentId, paymentKind };
}

/** Consumer-only response projections never return private snapshots, recipients, payloads or storage keys. */
@Injectable()
export class ManagementService {
  private readonly ledger;
  private readonly coordinator = new PostgresCreditOperationCoordinator();
  constructor(
    @Inject(DATABASE_ADAPTER) private readonly database: ApplicationDatabase,
    private readonly credits: CreditsService,
  ) {
    this.ledger = createCreditLedger(database);
  }
  async list(resource: ManagementResource, query: Record<string, unknown>) {
    const definition = resources[resource];
    record(query, [
      'page',
      'pageSize',
      'id',
      ...(definition.owner ? ['ownerId'] : []),
      ...(definition.status || resource === 'api-keys' ? ['status'] : []),
    ]);
    const { page, pageSize } = pagination(query),
      id = text(query.id, 191, false),
      ownerId = text(query.ownerId, 191, false),
      status = text(query.status, 64, false);
    if (status && !statusValues[resource]?.includes(status))
      throw new BadRequestException('Invalid management status');
    const now = new Date();
    const keyStatus =
      resource === 'api-keys' && status
        ? status === 'revoked'
          ? { revokedAt: { not: null } }
          : status === 'disabled'
            ? { revokedAt: null, isActive: false }
            : status === 'expired'
              ? { revokedAt: null, isActive: true, expiresAt: { lte: now } }
              : {
                  revokedAt: null,
                  isActive: true,
                  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                }
        : {};
    const where = {
      ...keyStatus,
      ...(id ? { id } : {}),
      ...(ownerId && definition.owner ? { [definition.owner]: ownerId } : {}),
      ...(status && definition.status ? { [definition.status]: status } : {}),
    };
    const result = await this.database.transaction(async (tx) => {
      const model = tx.model(definition.model),
        select: Record<string, unknown> = Object.fromEntries(
          [
            ...definition.fields,
            ...(['orders', 'subscriptions'].includes(resource) ? ['offer'] : []),
            ...(resource === 'orders' ? ['accountScope', 'paymentId'] : []),
          ].map((field) => [field, true]),
        );
      if (resource === 'api-keys') select.user = { select: { username: true } };
      if (resource === 'orders')
        select.subscriptionBinding = { select: { id: true, initialFulfilledAt: true } };
      const [data, total] = await Promise.all([
        model.findMany({
          where,
          select,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: [{ [definition.time]: 'desc' }, { id: 'desc' }],
        }),
        model.count({ where }),
      ]);
      return { data, total };
    });
    // Close the list transaction before the summary helper opens its read transaction; do not hold pool connections recursively.
    const data = await Promise.all(
      result.data.map(async (value) => {
        const row = value as Record<string, unknown>;
        if (resource === 'api-keys') {
          const { user, ...fields } = row,
            expired = fields.expiresAt instanceof Date && fields.expiresAt <= now;
          return {
            ...fields,
            username: (user as { username?: string } | null)?.username ?? null,
            status: fields.revokedAt
              ? 'revoked'
              : fields.isActive === false
                ? 'disabled'
                : expired
                  ? 'expired'
                  : 'active',
          };
        }
        if (resource !== 'orders' && resource !== 'subscriptions') return row;
        const {
          offer,
          subscriptionBinding,
          accountScope: _privateScope,
          paymentId: _privatePayment,
          ...fields
        } = row;
        if (!offer || typeof offer !== 'object') throw new Error('Stored offer is unavailable');
        const snapshot = offer as {
          description?: unknown;
          mode?: unknown;
          money?: { amount?: unknown; currency?: unknown };
        };
        if (
          !['payment', 'subscription'].includes(String(snapshot.mode)) ||
          typeof snapshot.money?.amount !== 'string' ||
          typeof snapshot.money?.currency !== 'string'
        )
          throw new Error('Stored offer is invalid');
        return {
          ...fields,
          ...(resource === 'orders' && snapshot.mode === 'subscription'
            ? {
                fulfilledAt:
                  (subscriptionBinding as { initialFulfilledAt?: Date } | null)
                    ?.initialFulfilledAt ?? null,
                subscriptionRecordId: (subscriptionBinding as { id?: string } | null)?.id ?? null,
              }
            : {}),
          ...(resource === 'orders'
            ? { refund: await readOrderRefundSummary(this.database, refundSummaryOrder(row)) }
            : {}),
          mode: snapshot.mode,
          title: typeof snapshot.description === 'string' ? snapshot.description : null,
          money: { amount: snapshot.money.amount, currency: snapshot.money.currency },
        };
      }),
    );
    return { data, total: result.total, page, pageSize };
  }
  private async owner(ownerId: string) {
    text(ownerId, 191);
    const user = await this.database
      .model('users')
      .findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!user) throw new NotFoundException('Account was not found');
  }
  async creditBalance(ownerId: string) {
    await this.owner(ownerId);
    return this.credits.balance(ownerId);
  }
  async creditLots(ownerId: string, query: Record<string, unknown>) {
    await this.owner(ownerId);
    return this.credits.lots(ownerId, creditPageOptions(query, false));
  }
  async grant(actorId: string, ownerId: string, keyValue: unknown, body: unknown) {
    const value = record(body, ['amount', 'description', 'expiresAt']),
      key = text(keyValue, 128)!,
      description = text(value.description, 500)!;
    if (
      !Number.isSafeInteger(value.amount) ||
      Number(value.amount) <= 0 ||
      Number(value.amount) > 2_147_483_647
    )
      throw new BadRequestException('Grant amount must be a positive 32-bit integer');
    const expiresAt =
      value.expiresAt === undefined || value.expiresAt === null
        ? undefined
        : new Date(text(value.expiresAt, 40)!);
    if (expiresAt && !Number.isFinite(expiresAt.getTime()))
      throw new BadRequestException('Invalid grant expiry');
    await this.owner(ownerId);
    const amount = Number(value.amount),
      sourceId = `admin-credit:${createHash('sha256').update(`${actorId}\0${key}`).digest('hex')}`;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          actorId,
          ownerId,
          amount,
          description,
          expiresAt: expiresAt?.toISOString() ?? null,
        }),
      )
      .digest('hex');
    try {
      return await this.database.transaction(async (tx) => {
        await this.coordinator.lockAccount(tx, ownerId);
        const exists = await tx.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [ownerId]);
        if (!exists.rows[0]) throw new NotFoundException('Account was not found');
        const prepared = await this.coordinator.prepare(tx, {
          idempotencyKey: sourceId,
          accountId: ownerId,
          operationType: 'ADMIN_CREDIT_GRANT',
          amount,
          resourceType: 'admin-credit-grant',
          resourceId: fingerprint,
        });
        const granted = prepared.claimed;
        if (granted) {
          if (expiresAt && expiresAt <= new Date())
            throw new BadRequestException('Grant expiry must be in the future');
          const account = (await tx
            .model('creditAccount')
            .findUnique({ where: { userId: ownerId }, select: { balance: true } })) as {
            balance: number;
          } | null;
          if (account && account.balance > 2_147_483_647 - amount)
            throw new ConflictException('Credit balance would exceed the supported range');
          await this.ledger.grant(tx, {
            accountId: ownerId,
            amount,
            source: 'admin',
            sourceId,
            expiresAt,
            description,
            transactionData: {
              type: 'GRANT',
              description,
              expireAt: expiresAt ?? null,
              metadata: { source: 'admin', sourceId, actorId, fingerprint },
            },
          });
        }
        if (granted)
          await tx.model('operationLogs').create({
            data: {
              module: 'credits',
              action: 'grant',
              userId: actorId,
              targetId: ownerId,
              targetType: 'account',
              status: 'SUCCESS',
              metadata: {
                sourceId,
                amount,
                description,
                expiresAt: expiresAt?.toISOString() ?? null,
              },
            },
          });
        const lots = await tx.model('creditLots').findMany({
          where: { userId: ownerId, source: 'admin', sourceId },
          select: {
            id: true,
            amount: true,
            remainingAmount: true,
            expiresAt: true,
            createdAt: true,
          },
        });
        if (lots.length !== 1) throw new ConflictException('Credit grant evidence is inconsistent');
        return { applied: granted, ownerId, amount, lot: lots[0] };
      });
    } catch (error) {
      if (error instanceof CreditOperationConflictError)
        throw new ConflictException('Grant request key was reused with different fields');
      throw error;
    }
  }
}
