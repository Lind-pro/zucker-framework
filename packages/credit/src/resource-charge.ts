import { brandPortError } from '@zucker-framework/fe-types/back-office';
import {
  QuotaReservationService,
  type QuotaReservationInput,
  type QuotaReservationRecord,
  type QuotaReservationStore,
} from './quota-reservation';

/** A reservation charged against one consumer-defined resource, such as a project. */
export interface ResourceChargeInput extends QuotaReservationInput {
  resourceType: string;
  resourceId: string;
}
/** Stored reservations must keep the resource they were charged for. */
export interface ResourceChargeRecord extends QuotaReservationRecord {
  resourceType: string;
  resourceId: string;
}
/**
 * Identity of one charge: the counter is part of it, so one resource can be charged once on each
 * counter that meters it (for example a project counts once against `projects` and its exports
 * separately against `exports`).
 */
export interface ResourceChargeQuery {
  subjectId: string;
  counter: string;
  resourceType: string;
  resourceId: string;
  now: Date;
  /** The caller's own reservation ID, which must not count as a prior charge. */
  exceptReservationId?: string;
}
/** State of the charge that currently occupies a resource on a counter. */
export type ActiveResourceChargeState = 'CONFIRMED' | 'RESERVED';

/**
 * Prior-charge port. Both methods run on the reservation transaction after the subject/counter
 * lock, so they observe every committed writer of that counter.
 */
export interface ResourceChargeLookup<Tx> {
  /**
   * The CONFIRMED charge, or a RESERVED charge whose expiresAt is after `query.now`, for exactly
   * (subject, counter, resourceType, resourceId) excluding `exceptReservationId`; otherwise null.
   */
  findActiveCharge(tx: Tx, query: ResourceChargeQuery): Promise<ActiveResourceChargeState | null>;
  /**
   * Moves RESERVED rows of exactly this (subject, counter, resource) whose expiresAt <= `query.now`
   * to EXPIRED (never confirming or charging them), so a stale reservation left by a crash or a
   * work that outlived its TTL cannot keep occupying the resource's storage key.
   */
  expireStale(tx: Tx, query: ResourceChargeQuery): Promise<number>;
}

/** `reservation` is null when the resource was already charged and this use is free. */
export interface ResourceCharge<R extends ResourceChargeRecord> {
  reservation: R | null;
  free: boolean;
}

/**
 * - `in_progress`: another caller holds a live reservation for this resource on this counter; retry
 *   after it confirms (then this use is free) or releases (then this use is charged).
 * - `conflict`: a reused reservation ID belongs to a different resource.
 */
export class ResourceChargeError extends Error {
  constructor(readonly reason: 'in_progress' | 'conflict', message: string) {
    super(message);
    this.name = 'ResourceChargeError';
    brandPortError(this);
  }
}

class ResourceAlreadyCharged extends Error {}

export interface ResourceChargeOptions {
  now?: () => Date;
  /** Release failures after a failed use are reported here; expiry remains the fallback. */
  onReleaseError?: (error: unknown, reservationId: string) => void;
  /**
   * Confirmation failures after the work succeeded (the reservation expired because the work
   * outlived its TTL, an administrator released it, or storage failed). `run` still returns the
   * work's result because the resource exists; the use is uncharged. Keep the TTL longer than the
   * work and log this.
   */
  onConfirmError?: (error: unknown, reservationId: string) => void;
}

/** Joins a caller's transaction instead of opening one (for example a task insert plus its charge). */
export interface ResourceChargeCallOptions<Tx> {
  tx?: Tx;
}

/**
 * Charges a counter once per resource: the first successful use confirms its reservation, a failed
 * use releases it, and later uses while a confirmed charge exists are free. A second caller that
 * arrives while the first use is still reserved gets `ResourceChargeError('in_progress')` instead
 * of a free use, so a failed first use can never leave a successful second use uncharged. The
 * prior-charge lookup happens inside the reservation transaction under the subject/counter lock.
 */
export class ResourceChargeService<Tx, R extends ResourceChargeRecord, I extends ResourceChargeInput> {
  private readonly clock: () => Date;
  private readonly root: QuotaReservationService<Tx, R, I>;
  constructor(
    private readonly store: QuotaReservationStore<Tx, R, I>,
    private readonly lookup: ResourceChargeLookup<Tx>,
    private readonly options: ResourceChargeOptions = {},
  ) {
    this.clock = options.now ?? (() => new Date());
    this.root = this.reservations();
  }

  /** Fast pre-check outside a reservation, for failing early; `begin` remains authoritative. */
  async isCharged(query: Omit<ResourceChargeQuery, 'now'>, options: ResourceChargeCallOptions<Tx> = {}): Promise<boolean> {
    const read = (tx: Tx) => this.lookup.findActiveCharge(tx, { ...query, now: this.clock() });
    return (await (options.tx !== undefined ? read(options.tx) : this.store.transaction(read))) !== null;
  }

  /** Reserves capacity unless the resource already holds a confirmed charge on this counter. */
  async begin(input: I, options: ResourceChargeCallOptions<Tx> = {}): Promise<ResourceCharge<R>> {
    for (const field of ['resourceType', 'resourceId'] as const)
      if (typeof input[field] !== 'string' || !input[field].trim())
        throw new TypeError(`Resource charge requires ${field}`);
    try {
      const reservation = await this.service(options.tx).reserve(input);
      // A reused ID must name the same resource; otherwise it would hand out another resource's charge.
      if (reservation.resourceType !== input.resourceType || reservation.resourceId !== input.resourceId)
        throw new ResourceChargeError('conflict', 'Reservation ID belongs to another resource');
      // A stable ID that was already confirmed by an earlier attempt is not charged again.
      if (reservation.status === 'CONFIRMED') return { reservation: null, free: true };
      return { reservation, free: false };
    } catch (error) {
      if (error instanceof ResourceAlreadyCharged) return { reservation: null, free: true };
      throw error;
    }
  }

  /** Confirms the charge after the first successful use. Free uses do nothing. */
  async complete(charge: ResourceCharge<R>, options: ResourceChargeCallOptions<Tx> = {}): Promise<boolean> {
    return charge.reservation ? this.service(options.tx).confirm(charge.reservation.id) : false;
  }

  /** Releases the reservation after a failed use so the resource can be charged by a later attempt. */
  async fail(charge: ResourceCharge<R>, reason?: string, options: ResourceChargeCallOptions<Tx> = {}): Promise<boolean> {
    return charge.reservation ? this.service(options.tx).release(charge.reservation.id, reason) : false;
  }

  /**
   * begin → work → complete. A work failure releases the reservation and rethrows the work error. A
   * confirmation failure after successful work is reported to `onConfirmError` and the result is
   * returned (inside a caller transaction it is rethrown, because that transaction is unusable).
   */
  async run<T>(input: I, work: (charge: ResourceCharge<R>) => Promise<T>, options: ResourceChargeCallOptions<Tx> = {}): Promise<T> {
    const charge = await this.begin(input, options);
    let result: T;
    try {
      result = await work(charge);
    } catch (error) {
      if (charge.reservation) {
        try {
          await this.fail(charge, 'resource-use-failed', options);
        } catch (releaseError) {
          this.options.onReleaseError?.(releaseError, charge.reservation.id);
        }
      }
      throw error;
    }
    try {
      await this.complete(charge, options);
    } catch (error) {
      if (options.tx !== undefined || !charge.reservation) throw error;
      this.options.onConfirmError?.(error, charge.reservation.id);
    }
    return result;
  }

  private service(tx: Tx | undefined): QuotaReservationService<Tx, R, I> {
    return tx === undefined ? this.root : this.reservations(tx);
  }

  private reservations(tx?: Tx): QuotaReservationService<Tx, R, I> {
    const store = this.store, lookup = this.lookup;
    // Explicit delegation keeps class-based stores' prototype methods bound.
    const wrapped: QuotaReservationStore<Tx, R, I> = {
      transaction: (work) => (tx !== undefined ? work(tx) : store.transaction(work)),
      lock: (current, identity) => store.lock(current, identity),
      find: (current, id) => store.find(current, id),
      insert: (current, input) => store.insert(current, input),
      transition: (current, id, from, to, transitionOptions) => store.transition(current, id, from, to, transitionOptions),
      charge: (current, reservation) => store.charge(current, reservation),
      expire: (current, before) => store.expire(current, before),
      assertCapacity: async (current, input) => {
        const query = this.query(input);
        await lookup.expireStale(current, query);
        const state = await lookup.findActiveCharge(current, query);
        if (state === 'CONFIRMED') throw new ResourceAlreadyCharged();
        if (state === 'RESERVED')
          throw new ResourceChargeError('in_progress', 'This resource is being charged by another request; retry shortly');
        await store.assertCapacity(current, input);
      },
    };
    return new QuotaReservationService(wrapped, this.clock);
  }

  private query(input: I): ResourceChargeQuery {
    return {
      subjectId: input.subjectId,
      counter: input.counter,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      now: this.clock(),
      ...(input.id ? { exceptReservationId: input.id } : {}),
    };
  }
}
