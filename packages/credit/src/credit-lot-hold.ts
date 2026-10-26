export type CreditLotHoldStatus = 'HELD' | 'CONFIRMED' | 'RELEASED';

export interface CreditLotHoldRecord {
  id: string;
  accountId: string;
  amount: number;
  status: CreditLotHoldStatus;
  selectedLotIds: readonly string[];
  resourceType: string;
  resourceId?: string;
  createdAt: Date;
  settledAt?: Date;
}
export interface CreditLotHoldAllocation {
  holdId: string;
  lotId: string;
  amount: number;
  activeAmount: number;
  expiredAmount: number;
  revokedAmount: number;
  releasedAmount: number;
  expiredAt?: Date;
}
export interface CreditLotHold extends CreditLotHoldRecord {
  allocations: readonly CreditLotHoldAllocation[];
  activeAmount: number;
  expiredAmount: number;
  revokedAmount: number;
  releasedAmount: number;
}
export interface CreateCreditLotHold {
  id: string;
  accountId: string;
  amount: number;
  lotIds: readonly string[];
  resourceType: string;
  resourceId?: string;
  operationKey: string;
  transactionData: Record<string, unknown>;
}
export interface SettleCreditLotHold {
  id: string;
  accountId: string;
  operationKey: string;
  transactionData: Record<string, unknown>;
  /** Defaults to the neutral EXPIRE journal type. The consumer owns descriptions and references. */
  expiryTransactionData?: Record<string, unknown>;
}
export interface CreditLotHoldResult { hold: CreditLotHold; changed: boolean }

/** All methods share the caller transaction and account lock. No timer, external I/O or implicit TTL. */
export interface CreditLotHoldStore<Tx> {
  find(tx: Tx, id: string): Promise<CreditLotHoldRecord | null>;
  create(tx: Tx, hold: CreditLotHoldRecord, allocations: readonly CreditLotHoldAllocation[]): Promise<void>;
  allocations(tx: Tx, holdId: string): Promise<readonly CreditLotHoldAllocation[]>;
  /** Every positive active allocation belonging to this account, including lots awaiting expiry maintenance. */
  activeAllocations(tx: Tx, accountId: string): Promise<readonly CreditLotHoldAllocation[]>;
  /** Exact old-value CAS; false must not be represented as a successful write. Identity/amount never change. */
  updateAllocation(tx: Tx, previous: CreditLotHoldAllocation, next: CreditLotHoldAllocation): Promise<boolean>;
  /** Atomic HELD -> terminal CAS. */
  settle(tx: Tx, id: string, status: 'CONFIRMED' | 'RELEASED', at: Date): Promise<boolean>;
}

export class CreditLotHoldError extends Error {
  constructor(readonly reason: 'unsupported' | 'invalid' | 'not_found' | 'conflict' | 'invariant', message = `Credit lot hold ${reason}`) {
    super(message); this.name = 'CreditLotHoldError';
  }
}
export class CreditLotHeldError extends Error {
  constructor() { super('Selected credit lots have active holds'); this.name = 'CreditLotHeldError'; }
}
export class CreditHoldMigrationRequiredError extends Error {
  constructor() { super('Frozen balance is not fully represented by credit lot holds; explicit reconciliation is required'); this.name = 'CreditHoldMigrationRequiredError'; }
}
