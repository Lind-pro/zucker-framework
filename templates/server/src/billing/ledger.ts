import { BatchCreditLedger, PostgresCreditOperationCoordinator } from '@zucker-framework/credit';
import type {
  BatchCreditModels,
  BatchCreditLedgerOptions,
  CreditLotConsumption,
  CreateCreditLotHold,
  SettleCreditLotHold,
} from '@zucker-framework/credit';
import { ApplicationDatabase, type ApplicationTransaction } from '../database';
import { createCreditHoldStore } from '../credits/hold.store';
import { readRefundCreditBlocks, RefundCreditBlockedError } from '../credits/refund-credit-blocks';

// Offer fulfillment policy helpers moved to the billing host; re-exported for template importers.
export {
  validateCreditFulfillmentPolicy, paidPeriodEnd, creditExpiresAt, checkoutCreditOperation, type CreditFulfillmentPolicy,
} from '@zucker-framework/back-office/billing';

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
