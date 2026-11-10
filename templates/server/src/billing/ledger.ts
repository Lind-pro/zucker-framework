import { createHash } from 'node:crypto';
import { BatchCreditLedger, PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import { CYCLE_FOR_INTERVAL } from '@zucker-framework/fe-types/back-office';
import { HostedCheckoutError, addBillingCycle, readPlanPriceSnapshot } from '@zucker-framework/payment';
import type {
  BatchCreditModels,
  BatchCreditLedgerOptions,
  CreditOperationInput,
  CreditLotConsumption,
  CreateCreditLotHold,
  SettleCreditLotHold,
} from '@zucker-framework/credit';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { createCreditHoldStore } from '../credits/hold.store';
import { readRefundCreditBlocks, RefundCreditBlockedError } from '../credits/refund-credit-blocks';

export interface CreditFulfillmentPolicy {
  credits: number;
  expiresInDays: number | null;
  grantBasis?: 'period' | 'payment';
  /** Plan offers only: the credits expire with the paid period (one-time term end, cycle end). */
  expiresAtPeriodEnd?: true;
}

/**
 * Consumer policy for this template's credit offers, never a client-selected amount. A plan offer
 * also carries its frozen `plan` snapshot (validated by the plan write-back hook) and may grant no
 * credits; a credit pack offer carries its frozen `pack` snapshot (audit only: the grant reads
 * `credits`/`expiresInDays` here); every other offer must grant a positive amount.
 */
export function validateCreditFulfillmentPolicy(value: unknown): CreditFulfillmentPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid credit fulfillment policy');
  const policy = value as Record<string, unknown>;
  const plan = policy.plan !== undefined;
  const snapshot = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
  if (
    Object.keys(policy).some((key) => !['credits', 'expiresInDays', 'grantBasis', 'plan', 'pack', 'expiresAtPeriodEnd'].includes(key)) ||
    (plan && !snapshot(policy.plan)) ||
    (policy.pack !== undefined && (plan || !snapshot(policy.pack))) ||
    (policy.expiresAtPeriodEnd !== undefined &&
      (policy.expiresAtPeriodEnd !== true || !plan || (policy.expiresInDays ?? null) !== null)) ||
    !Number.isSafeInteger(policy.credits) ||
    Number(policy.credits) < (plan ? 0 : 1) ||
    Number(policy.credits) > 2_147_483_647
  )
    throw new TypeError('Invalid credit fulfillment policy');
  const days = policy.expiresInDays ?? null;
  if (
    days !== null &&
    (!Number.isSafeInteger(days) || Number(days) <= 0 || Number(days) > 100_000_000)
  )
    throw new TypeError('Invalid credit expiry policy');
  if (
    policy.grantBasis !== undefined &&
    policy.grantBasis !== 'period' &&
    policy.grantBasis !== 'payment'
  )
    throw new TypeError('Invalid subscription grant basis');
  return {
    credits: Number(policy.credits),
    expiresInDays: days === null ? null : Number(days),
    ...(policy.grantBasis === undefined ? {} : { grantBasis: policy.grantBasis }),
    ...(policy.expiresAtPeriodEnd === true ? { expiresAtPeriodEnd: true as const } : {}),
  };
}

/**
 * End of the paid period a grant belongs to, from the frozen plan snapshot in `fulfillmentData`.
 * One-time: `start + termDays`; lifetime: null (never); a subscription cycle: the receipt's proven
 * period end, else one billing interval after payment (receipt-basis channels).
 */
export function paidPeriodEnd(fulfillmentData: unknown, start: Date, receiptPeriodEnd?: Date | null): Date | null {
  const raw = fulfillmentData && typeof fulfillmentData === 'object' ? (fulfillmentData as { plan?: unknown }).plan : undefined;
  const plan = readPlanPriceSnapshot(raw);
  if (!plan) throw new HostedCheckoutError('conflict', 'Plan snapshot of the order is invalid');
  if (plan.interval === 'lifetime') return null;
  if (plan.interval === 'one_time') return new Date(start.getTime() + (plan.termDays ?? 0) * 86_400_000);
  const cycle = CYCLE_FOR_INTERVAL[plan.interval];
  return receiptPeriodEnd ?? addBillingCycle(start, cycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY');
}

/** Expiry of granted credits: with the paid period, `expiresInDays` after the grant, or never. */
export function creditExpiresAt(policy: CreditFulfillmentPolicy, grantedAt: Date, periodEnd: () => Date | null): Date | null {
  const expiresAt = policy.expiresAtPeriodEnd ? periodEnd()
    : policy.expiresInDays === null ? null : new Date(grantedAt.getTime() + policy.expiresInDays * 86_400_000);
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new TypeError('Credit expiry exceeds the supported date range');
  return expiresAt;
}

export function checkoutCreditOperation(
  orderId: string,
  ownerId: string,
  credits: number,
): CreditOperationInput {
  return {
    idempotencyKey: `checkout-credit:${createHash('sha256').update(orderId).digest('hex')}`,
    accountId: ownerId,
    operationType: 'CHECKOUT_CREDIT_GRANT',
    amount: credits,
    resourceType: 'billing-order',
    resourceId: orderId,
  };
}

/** Only the template's existing canonical models and field mapping; no parallel wallet. */
function ledgerOptions(
  database: ApplicationDatabase,
  excludedLots?: ReadonlySet<string>,
): BatchCreditLedgerOptions<ApplicationTransaction> {
  const coordinator = new PostgresCreditOperationCoordinator();
  return {
    accountField: 'userId',
    transactionLotsField: 'ledgerIds',
    allocationLotField: 'creditLotId',
    // Spend credits that would expire before credits that would not (confirmed product decision).
    consumeOrder: 'expiry_first',
    holds: createCreditHoldStore(),
    models: (tx) => {
      // Prisma delegates implement upsert/findFirst beyond the neutral adapter's common surface.
      const lots = tx.model('creditLots') as BatchCreditModels['lots'];
      const issuedLotIds: string[] = [];
      return {
        lots: {
          findMany: async (args) => {
            const result = await lots.findMany(args);
            return excludedLots ? result.filter((lot) => !excludedLots.has(lot.id)) : result;
          },
          findFirst: (args) => lots.findFirst(args),
          update: (args) => lots.update(args),
          create: async (args) => {
            const lot = await lots.create(args);
            issuedLotIds.push(lot.id);
            return lot;
          },
        },
        balances: tx.model('creditAccount') as unknown as BatchCreditModels['balances'],
        transactions: {
          create: async (args) => {
            const data = args.data as Record<string, unknown>;
            return (await tx.model('creditTransaction').create({
              ...args,
              data: {
                ...data,
                balance: data.balanceAfter,
                ledgerIds: data.ledgerIds ?? issuedLotIds,
              },
            })) as { id: string };
          },
        },
        consumptions: tx.model('creditConsumptions') as BatchCreditModels['consumptions'],
        allocations: tx.model('creditAllocations'),
      };
    },
    scanLots: () => database.model('creditLots') as BatchCreditModels['lots'],
    transaction: (work) => database.transaction(work),
    lockAccount: (tx, ownerId) => coordinator.lockAccount(tx, ownerId),
    prepare: (tx, operation) => coordinator.prepare(tx, operation),
  };
}

interface ApplicationCreditLedgerOptions {
  refundSettlement?: boolean;
}
const refundResources = new Set(['refund-request', 'refund-observation']);
/** Eligibility is application policy; canonical balance, holds and idempotency remain in the public ledger. */
class ApplicationCreditLedger extends BatchCreditLedger<ApplicationTransaction> {
  private readonly coordinator = new PostgresCreditOperationCoordinator();
  constructor(
    private readonly database: ApplicationDatabase,
    private readonly policy: ApplicationCreditLedgerOptions,
  ) {
    super(ledgerOptions(database));
  }
  override async consume(tx: ApplicationTransaction, input: CreditLotConsumption) {
    await this.coordinator.lockAccount(tx, input.accountId);
    const blocked = await readRefundCreditBlocks(tx, input.accountId);
    // Even the refund settlement channel cannot spend credits from a known refunded source.
    return blocked.size
      ? new BatchCreditLedger(ledgerOptions(this.database, new Set(blocked.keys()))).consume(
          tx,
          input,
        )
      : super.consume(tx, input);
  }
  override async hold(tx: ApplicationTransaction, input: CreateCreditLotHold, now?: Date) {
    await this.coordinator.lockAccount(tx, input.accountId);
    const existing = (await tx
      .model('creditHolds')
      .findUnique({ where: { id: input.id }, select: { accountId: true } })) as {
      accountId: string;
    } | null;
    // Existing commands are validated and replayed by the ledger without allocating again.
    if (
      existing?.accountId !== input.accountId &&
      !(this.policy.refundSettlement && refundResources.has(input.resourceType))
    ) {
      const blocked = await readRefundCreditBlocks(tx, input.accountId, now);
      if (input.lotIds.some((id) => blocked.has(id))) throw new RefundCreditBlockedError();
    }
    return super.hold(tx, input, now);
  }
  override async confirmHold(tx: ApplicationTransaction, input: SettleCreditLotHold, now?: Date) {
    await this.coordinator.lockAccount(tx, input.accountId);
    const held = (await tx
      .model('creditHolds')
      .findUnique({
        where: { id: input.id },
        select: { accountId: true, status: true, resourceType: true },
      })) as { accountId: string; status: string; resourceType: string } | null;
    if (
      held?.accountId === input.accountId &&
      held.status === 'HELD' &&
      !(this.policy.refundSettlement && refundResources.has(held.resourceType))
    ) {
      const blocked = await readRefundCreditBlocks(tx, input.accountId, now);
      const allocations = (await tx
        .model('creditHoldAllocations')
        .findMany({
          where: { holdId: input.id, activeAmount: { gt: 0 } },
          select: { creditLotId: true },
        })) as Array<{ creditLotId: string }>;
      if (allocations.some((allocation) => blocked.has(allocation.creditLotId)))
        throw new RefundCreditBlockedError();
    }
    return super.confirmHold(tx, input, now);
  }
}

export function createCreditLedger(
  database: ApplicationDatabase,
  options: ApplicationCreditLedgerOptions = {},
): BatchCreditLedger<ApplicationTransaction> {
  return new ApplicationCreditLedger(database, options);
}
