import type { CreditTransactionType as _CreditTransactionType } from './credit.service';

export { CreditTransactionType, CreditService, CREDIT_EVENT_TOPICS } from './credit.service';
export { QuotaReservationService, QuotaReservationError } from './quota-reservation';
export type {
  QuotaReservationState,
  QuotaReservationErrorReason,
  QuotaReservationIdentity,
  QuotaReservationInput,
  QuotaReservationRecord,
  QuotaReservationStore,
} from './quota-reservation';

export type {
  CreditQueryOptions,
  CreditQueryResult,
  CreditTransactionRecord,
  CreditEventPayload,
} from './credit.service';

export interface CreditTransaction {
  id: string;
  userId: string;
  type: _CreditTransactionType;
  amount: number;
  balance: number;
  description: string;
  expireAt: Date | null;
  orderId: string | null;
  expired: boolean;
  createdAt: Date;
}

export { ZuckerCreditModule } from './credit.module';
export type { CreditModuleAsyncOptions, CreditModuleAdapterFactory } from './credit.module';

export {
  CreditOperationConflictError,
  CreditOperationValidationError,
  PostgresCreditOperationCoordinator,
} from './postgres-credit-operation-coordinator';
export type {
  CreditOperationInput,
  CreditOperationReceipt,
  CreditSqlClient,
  CreditSqlQueryResult,
  PreparedCreditOperation,
} from './postgres-credit-operation-coordinator';

export {
  QuotaCapacity,
  QuotaCapacityInputError,
  QuotaCapacityExceededError,
} from './quota-capacity';
export type {
  QuotaCapacityKey,
  QuotaCapacityStore,
  QuotaCapacityRequest,
  QuotaCapacitySnapshot,
  QuotaUsageSnapshot,
  QuotaReservationCapacity,
} from './quota-capacity';

export {
  BatchCreditLedger,
  BatchCreditAmountError,
  BatchCreditInsufficientError,
} from './batch-credit-ledger';
export type {
  CreditLot,
  BatchCreditModels,
  BatchCreditLedgerOptions,
  CreditLotGrant,
  CreditLotConsumption,
} from './batch-credit-ledger';

export { CreditLotHoldError, CreditLotHeldError, CreditHoldMigrationRequiredError } from './credit-lot-hold';
export type {
  CreditLotHoldStatus, CreditLotHoldRecord, CreditLotHoldAllocation, CreditLotHold,
  CreateCreditLotHold, SettleCreditLotHold, CreditLotHoldResult, CreditLotHoldStore,
} from './credit-lot-hold';

export {
  UNLIMITED_QUOTA,
  EntitlementService,
  EntitlementValidationError,
  validateEntitlementCatalog,
  validatePlanGrant,
  meteredCounters,
  counterLimit,
  isActiveTerm,
  periodKey,
  resolveEntitlements,
  counterSnapshot,
} from './entitlement';
export type {
  EntitlementCounterPeriod,
  EntitlementFeatureCategory,
  EntitlementFeatureDefinition,
  EntitlementCounterDefinition,
  EntitlementCatalog,
  PlanGrant,
  SubscriptionTerm,
  ResolvedEntitlements,
  CounterSnapshot,
  EntitlementServiceOptions,
} from './entitlement';

export { ResourceChargeService, ResourceChargeError } from './resource-charge';
export type {
  ResourceChargeInput,
  ResourceChargeRecord,
  ResourceChargeQuery,
  ActiveResourceChargeState,
  ResourceChargeCallOptions,
  ResourceChargeLookup,
  ResourceCharge,
  ResourceChargeOptions,
} from './resource-charge';
