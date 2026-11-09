import { brandPortError, type PortErrorReason } from '@zucker-framework/fe-types/back-office';

export type QuotaReservationState = 'RESERVED' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED';

export interface QuotaReservationIdentity {
  subjectId: string;
  counter: string;
  amount: number;
}
export interface QuotaReservationInput extends QuotaReservationIdentity {
  id?: string;
  expiresAt: Date;
}
export interface QuotaReservationRecord extends QuotaReservationIdentity {
  id: string;
  expiresAt: Date;
  status: QuotaReservationState;
}

/** All writes, including the charge, must use the supplied transaction. */
export interface QuotaReservationStore<Tx, R extends QuotaReservationRecord, I extends QuotaReservationInput> {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** Serialize every writer of this subject/counter, including direct consumption. */
  lock(tx: Tx, identity: QuotaReservationIdentity): Promise<void>;
  find(tx: Tx, id: string): Promise<R | null>;
  /** Product entitlement/period policy may invoke QuotaCapacity inside this transaction. */
  assertCapacity(tx: Tx, input: I): Promise<void>;
  insert(tx: Tx, input: I): Promise<R>;
  /** Atomic CAS. When expiresAfter is set, require expiresAt > expiresAfter. */
  transition(tx: Tx, id: string, from: 'RESERVED', to: QuotaReservationState,
    options: { at: Date; expiresAfter?: Date; reason?: string }): Promise<boolean>;
  /** Charge using the reservation's captured period/policy, never today's replacement. */
  charge(tx: Tx, reservation: R): Promise<void>;
  /** Atomic bulk update of RESERVED rows with expiresAt < before; never confirm/charge. */
  expire(tx: Tx, before: Date): Promise<number>;
}

export type QuotaReservationErrorReason = Extract<PortErrorReason, 'invalid' | 'not_found' | 'conflict' | 'inactive'>;
export class QuotaReservationError extends Error {
  constructor(readonly reason: QuotaReservationErrorReason) {
    super(`Quota reservation ${reason}`);
    this.name = 'QuotaReservationError';
    brandPortError(this);
  }
}

/** Durable state transitions; no product schema, quota names, prices or task policy. */
export class QuotaReservationService<Tx, R extends QuotaReservationRecord, I extends QuotaReservationInput> {
  constructor(private readonly store: QuotaReservationStore<Tx, R, I>,
    private readonly now: () => Date = () => new Date()) {}

  async reserve(input: I): Promise<R> {
    this.identity(input);
    if (input.id !== undefined) this.identifier(input.id);
    const at = this.clock();
    if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= at) {
      throw new QuotaReservationError('invalid');
    }
    return this.store.transaction(async tx => {
      await this.store.lock(tx, input);
      const at = this.clock();
      if (input.expiresAt <= at) throw new QuotaReservationError('inactive');
      if (input.id) {
        const existing = await this.store.find(tx, input.id);
        if (existing) {
          this.sameIdentity(existing, input);
          if (existing.status === 'CONFIRMED' || (existing.status === 'RESERVED' && existing.expiresAt > at)) return existing;
          throw new QuotaReservationError('inactive');
        }
      }
      await this.store.assertCapacity(tx, input);
      return this.store.insert(tx, input);
    });
  }

  async confirm(id: string): Promise<boolean> {
    this.identifier(id);
    return this.store.transaction(async tx => {
      const row = await this.lockedRecord(tx, id);
      if (row.status === 'CONFIRMED') return false;
      const at = this.clock();
      if (row.status !== 'RESERVED' || row.expiresAt <= at) throw new QuotaReservationError('inactive');
      const claimed = await this.store.transition(tx, id, 'RESERVED', 'CONFIRMED', { at, expiresAfter: at });
      if (!claimed) {
        const current = await this.store.find(tx, id);
        if (current) this.sameIdentity(current, row);
        if (current?.status === 'CONFIRMED') return false;
        throw new QuotaReservationError('inactive');
      }
      // Any charge error must roll back the CAS with the same transaction.
      await this.store.charge(tx, row);
      return true;
    });
  }

  async release(id: string, reason?: string): Promise<boolean> {
    this.identifier(id);
    return this.store.transaction(async tx => {
      const row = await this.lockedRecord(tx, id);
      if (row.status !== 'RESERVED') return false;
      return this.store.transition(tx, id, 'RESERVED', 'RELEASED', { at: this.clock(), reason });
    });
  }

  expire(): Promise<number> {
    const before = this.clock();
    return this.store.transaction(tx => this.store.expire(tx, before));
  }

  private async lockedRecord(tx: Tx, id: string): Promise<R> {
    const first = await this.store.find(tx, id);
    if (!first) throw new QuotaReservationError('not_found');
    this.identity(first);
    await this.store.lock(tx, first);
    // The first read may precede a concurrent confirmation/release; refresh after locking.
    const current = await this.store.find(tx, id);
    if (!current) throw new QuotaReservationError('not_found');
    this.sameIdentity(current, first);
    if (!(current.expiresAt instanceof Date) || !Number.isFinite(current.expiresAt.getTime())) {
      throw new QuotaReservationError('invalid');
    }
    return current;
  }
  private sameIdentity(row: QuotaReservationIdentity, input: QuotaReservationIdentity): void {
    this.identity(row);
    if (row.subjectId !== input.subjectId || row.counter !== input.counter || row.amount !== input.amount) {
      throw new QuotaReservationError('conflict');
    }
  }
  private identity(value: QuotaReservationIdentity): void {
    this.identifier(value.subjectId);
    this.identifier(value.counter);
    if (!Number.isSafeInteger(value.amount) || value.amount <= 0) throw new QuotaReservationError('invalid');
  }
  private identifier(value: string): void {
    if (typeof value !== 'string' || !value.trim()) throw new QuotaReservationError('invalid');
  }
  private clock(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new QuotaReservationError('invalid');
    return new Date(value);
  }
}
