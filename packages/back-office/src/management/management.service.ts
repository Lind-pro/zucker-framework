import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DATABASE_ADAPTER, type DatabaseAdapter } from '@zucker-framework/core';
import { CreditOperationConflictError, PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { AccessLogService, OperationLogService } from '@zucker-framework/logging';
import { listLogRecords } from '@zucker-framework/admin';
import type { ResolvedManagementOptions } from './management.options';
import {
  assertSqlTransaction,
  type ManagementCreditLedgerPort,
  type ManagementCreditsPort,
  type ManagementRefundOrder,
  type ManagementRefundSummaryPort,
} from './management.ports';
import {
  MANAGEMENT_CREDIT_LEDGER,
  MANAGEMENT_CREDITS,
  MANAGEMENT_OPTIONS,
  MANAGEMENT_REFUND_SUMMARY,
} from './management.tokens';
import {
  MANAGEMENT_RECORDS,
  managementPagination,
  managementRecord,
  managementText,
  orderAmounts,
  type ManagementRecordResource,
} from './management.records';

/** Resource names accepted by `list` (template names; `subscriptions` = provider-billed subscriptions). */
export type ManagementResource = ManagementRecordResource | 'access-logs' | 'operation-logs';

function refundOrder(row: Record<string, unknown>): ManagementRefundOrder {
  const { id, ownerId, providerId, accountScope, paymentId, paymentKind } = row;
  if (
    typeof id !== 'string' || typeof ownerId !== 'string' || typeof providerId !== 'string' || typeof accountScope !== 'string' ||
    (paymentId !== null && typeof paymentId !== 'string') ||
    (paymentKind !== null && paymentKind !== 'payment-intent' && paymentKind !== 'invoice' && paymentKind !== 'capture' && paymentKind !== 'transaction')
  )
    throw new Error('Stored payment identity is invalid');
  return { id, ownerId, providerId, accountScope, paymentId, paymentKind };
}

/**
 * Read-only back-office projections over the consumer's models, plus the audited administrator
 * credit grant. Responses never carry private snapshots, recipients, payloads, payment identities or
 * storage keys. Model names come from the options; persisted logs go through the logging services so
 * the log list has one contract (`listLogRecords`, shared with `@zucker-framework/admin` and fe-admin).
 */
@Injectable()
export class BackOfficeManagementService {
  private readonly coordinator = new PostgresCreditOperationCoordinator();
  constructor(
    @Inject(DATABASE_ADAPTER) protected readonly database: DatabaseAdapter,
    @Inject(MANAGEMENT_OPTIONS) protected readonly options: ResolvedManagementOptions,
    @Optional() @Inject(MANAGEMENT_REFUND_SUMMARY) private readonly refunds?: ManagementRefundSummaryPort,
    @Optional() @Inject(MANAGEMENT_CREDITS) private readonly credits?: ManagementCreditsPort,
    @Optional() @Inject(MANAGEMENT_CREDIT_LEDGER) private readonly ledger?: ManagementCreditLedgerPort,
    @Optional() @Inject(AccessLogService) private readonly accessLogs?: AccessLogService,
    @Optional() @Inject(OperationLogService) private readonly operationLogs?: OperationLogService,
  ) {}

  async list(resource: ManagementResource, query: Record<string, unknown>) {
    if (resource === 'access-logs' || resource === 'operation-logs') {
      const kind = resource === 'access-logs' ? 'access' : 'operation';
      const service = kind === 'access' ? this.accessLogs : this.operationLogs;
      if (!service) throw new Error('[back-office/management] log lists need ZuckerLoggingModule.forRoot({ persistence })');
      return listLogRecords(kind, service, query);
    }
    const definition = MANAGEMENT_RECORDS[resource];
    if (!definition) throw new BadRequestException('Unsupported management resource');
    managementRecord(query, ['page', 'pageSize', 'id', ...(definition.owner ? ['ownerId'] : []), ...(definition.status || resource === 'api-keys' ? ['status'] : [])]);
    const { page, pageSize } = managementPagination(query),
      id = managementText(query.id, 191, false),
      ownerId = managementText(query.ownerId, 191, false),
      status = managementText(query.status, 64, false);
    if (status && !(definition.statuses as readonly string[] | undefined)?.includes(status)) throw new BadRequestException('Invalid management status');
    const now = new Date();
    const keyStatus = resource === 'api-keys' && status
      ? status === 'revoked' ? { revokedAt: { not: null } }
        : status === 'disabled' ? { revokedAt: null, isActive: false }
          : status === 'expired' ? { revokedAt: null, isActive: true, expiresAt: { lte: now } }
            : { revokedAt: null, isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
      : {};
    const where = {
      ...keyStatus,
      ...(id ? { id } : {}),
      ...(ownerId && definition.owner ? { [definition.owner]: ownerId } : {}),
      ...(status && definition.status ? { [definition.status]: status } : {}),
    };
    const billed = resource === 'orders' || resource === 'subscriptions';
    const result = await this.database.$transaction(async (tx) => {
      const model = tx.model(this.options.models[definition.model]);
      const select: Record<string, unknown> = Object.fromEntries(
        [...definition.fields, ...(billed ? ['offer'] : []), ...(resource === 'orders' ? ['accountScope', 'paymentId'] : [])]
          .map((field) => [field, true]),
      );
      if (resource === 'api-keys') select.user = { select: { username: true } };
      if (resource === 'orders') select.subscriptionBinding = { select: { id: true, initialFulfilledAt: true } };
      const [data, total] = await Promise.all([
        model.findMany({ where, select, skip: (page - 1) * pageSize, take: pageSize, orderBy: [{ [definition.time]: 'desc' }, { id: 'desc' }] }),
        model.count({ where }),
      ]);
      return { data: data as Record<string, unknown>[], total };
    });
    // The list transaction is closed before the refund port opens its own read; no nested pool holds.
    const data = await Promise.all(result.data.map(async (row) => {
      if (resource === 'api-keys') {
        const { user, ...fields } = row, expired = fields.expiresAt instanceof Date && fields.expiresAt <= now;
        return {
          ...fields,
          username: (user as { username?: string } | null)?.username ?? null,
          status: fields.revokedAt ? 'revoked' : fields.isActive === false ? 'disabled' : expired ? 'expired' : 'active',
        };
      }
      if (!billed) return row;
      const { offer, subscriptionBinding, accountScope: _scope, paymentId: _payment, ...fields } = row;
      if (!offer || typeof offer !== 'object') throw new Error('Stored offer is unavailable');
      const snapshot = offer as {
        description?: unknown; mode?: unknown; money?: { amount?: unknown; currency?: unknown };
        promotion?: { payable?: { amount?: unknown; currency?: unknown }; discount?: { amount?: unknown; currency?: unknown } } | null;
      };
      if (!['payment', 'subscription'].includes(String(snapshot.mode)) || typeof snapshot.money?.amount !== 'string' || typeof snapshot.money?.currency !== 'string')
        throw new Error('Stored offer is invalid');
      const binding = subscriptionBinding as { id?: string; initialFulfilledAt?: Date } | null;
      return {
        ...fields,
        ...(resource === 'orders' && snapshot.mode === 'subscription'
          ? { fulfilledAt: binding?.initialFulfilledAt ?? null, subscriptionRecordId: binding?.id ?? null } : {}),
        ...(resource === 'orders' ? { refund: this.refunds ? await this.refunds.summarize(refundOrder(row)) : null } : {}),
        mode: snapshot.mode,
        title: typeof snapshot.description === 'string' ? snapshot.description : null,
        // Orders show what was charged (the frozen payable after a promotion), the list price and the discount.
        ...orderAmounts(resource, snapshot.money as { amount: string; currency: string }, snapshot.promotion),
      };
    }));
    return { data, total: result.total, page, pageSize };
  }

  private async owner(ownerId: string) {
    managementText(ownerId, 191);
    const user = await this.database.model(this.options.models.users).findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!user) throw new NotFoundException('Account was not found');
  }
  private creditPorts() {
    if (!this.credits || !this.ledger) throw new Error('[back-office/management] credit features need the credits and creditLedger ports');
    return { credits: this.credits, ledger: this.ledger };
  }
  async creditBalance(ownerId: string) {
    const { credits } = this.creditPorts();
    await this.owner(ownerId);
    return credits.balance(ownerId);
  }
  async creditLots(ownerId: string, query: Record<string, unknown>) {
    const { credits } = this.creditPorts();
    await this.owner(ownerId);
    return credits.lots(ownerId, query);
  }

  /** Idempotent per (actor, idempotency key); a reused key with other fields is a 409. */
  async grant(actorId: string, ownerId: string, keyValue: unknown, body: unknown) {
    const { ledger } = this.creditPorts();
    const value = managementRecord(body, ['amount', 'description', 'expiresAt']),
      key = managementText(keyValue, 128)!,
      description = managementText(value.description, 500)!;
    if (!Number.isSafeInteger(value.amount) || Number(value.amount) <= 0 || Number(value.amount) > 2_147_483_647)
      throw new BadRequestException('Grant amount must be a positive 32-bit integer');
    const expiresAt = value.expiresAt === undefined || value.expiresAt === null ? undefined : new Date(managementText(value.expiresAt, 40)!);
    if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new BadRequestException('Invalid grant expiry');
    await this.owner(ownerId);
    const amount = Number(value.amount),
      sourceId = `admin-credit:${createHash('sha256').update(`${actorId}\0${key}`).digest('hex')}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ actorId, ownerId, amount, description, expiresAt: expiresAt?.toISOString() ?? null }))
      .digest('hex');
    const { models, tables } = this.options;
    try {
      return await this.database.$transaction(async (adapter) => {
        const tx = assertSqlTransaction(adapter);
        await this.coordinator.lockAccount(tx, ownerId);
        const exists = await tx.query(`SELECT id FROM "${tables.users}" WHERE id=$1 FOR SHARE`, [ownerId]);
        if (!exists.rows[0]) throw new NotFoundException('Account was not found');
        const prepared = await this.coordinator.prepare(tx, {
          idempotencyKey: sourceId, accountId: ownerId, operationType: 'ADMIN_CREDIT_GRANT', amount,
          resourceType: 'admin-credit-grant', resourceId: fingerprint,
        });
        const granted = prepared.claimed;
        if (granted) {
          if (expiresAt && expiresAt <= new Date()) throw new BadRequestException('Grant expiry must be in the future');
          const account = (await tx.model(models.creditAccounts).findUnique({ where: { userId: ownerId }, select: { balance: true } })) as { balance: number } | null;
          if (account && account.balance > 2_147_483_647 - amount) throw new ConflictException('Credit balance would exceed the supported range');
          await ledger.grant(tx, {
            accountId: ownerId, amount, source: 'admin', sourceId, expiresAt, description,
            transactionData: { type: 'GRANT', description, expireAt: expiresAt ?? null, metadata: { source: 'admin', sourceId, actorId, fingerprint } },
          });
          await tx.model(models.operationLogs).create({
            data: {
              module: 'credits', action: 'grant', userId: actorId, targetId: ownerId, targetType: 'account', status: 'SUCCESS',
              metadata: { sourceId, amount, description, expiresAt: expiresAt?.toISOString() ?? null },
            },
          });
        }
        const lots = await tx.model(models.creditLots).findMany({
          where: { userId: ownerId, source: 'admin', sourceId },
          select: { id: true, amount: true, remainingAmount: true, expiresAt: true, createdAt: true },
        });
        if (lots.length !== 1) throw new ConflictException('Credit grant evidence is inconsistent');
        return { applied: granted, ownerId, amount, lot: lots[0] };
      });
    } catch (error) {
      if (error instanceof CreditOperationConflictError) throw new ConflictException('Grant request key was reused with different fields');
      throw error;
    }
  }
}
