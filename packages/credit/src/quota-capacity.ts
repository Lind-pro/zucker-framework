export interface QuotaCapacityKey {
  subjectId: string;
  counter: string;
  period: string;
}
export interface QuotaUsageSnapshot {
  used: number;
  limit: number;
}
export interface QuotaReservationCapacity {
  amount: number;
  expiresAt?: Date | null;
  /** Unknown legacy periods remain counted rather than silently granting capacity. */
  period?: string | null;
}

/** All methods must use one caller-owned transaction and the same capacity lock as reservation writers. */
export interface QuotaCapacityStore {
  lock(key: QuotaCapacityKey): Promise<void>;
  /** Atomic create/update of the configured limit; existing usage must not be reset. */
  ensureUsage(key: QuotaCapacityKey, limit: number): Promise<QuotaUsageSnapshot>;
  readUsage(key: QuotaCapacityKey): Promise<QuotaUsageSnapshot>;
  reservations(key: QuotaCapacityKey): Promise<readonly QuotaReservationCapacity[]>;
  /** One conditional update: increment only if used <= maximumUsedBefore. */
  incrementIfCapacity(
    key: QuotaCapacityKey,
    amount: number,
    maximumUsedBefore: number,
  ): Promise<boolean>;
}
export interface QuotaCapacityRequest extends QuotaCapacityKey {
  amount: number;
  limit: number;
  now?: Date;
}
export interface QuotaCapacitySnapshot extends QuotaUsageSnapshot {
  reserved: number;
  remaining: number;
  allowed: boolean;
}
export class QuotaCapacityInputError extends Error {
  constructor(readonly field: string) {
    super(`Invalid quota ${field}`);
    this.name = 'QuotaCapacityInputError';
  }
}
export class QuotaCapacityExceededError extends Error {
  constructor(
    readonly snapshot: QuotaCapacitySnapshot,
    readonly requested: number,
  ) {
    super('Quota capacity exceeded');
    this.name = 'QuotaCapacityExceededError';
  }
}

/** Periodic capacity mechanics only. Entitlements, unlimited policy, events and thresholds belong to consumers. */
export class QuotaCapacity {
  async check(
    store: QuotaCapacityStore,
    request: QuotaCapacityRequest,
  ): Promise<QuotaCapacitySnapshot> {
    this.validate(request);
    await store.lock(request);
    const usage = await store.ensureUsage(request, request.limit);
    if (!Number.isSafeInteger(usage.used) || usage.used < 0)
      throw new QuotaCapacityInputError('usage');
    const now = request.now ?? new Date();
    const reservations = (await store.reservations(request)).filter(
      (item) =>
        (!item.expiresAt || item.expiresAt > now) &&
        (!item.period || item.period === request.period),
    );
    for (const item of reservations) {
      if (!Number.isSafeInteger(item.amount) || item.amount < 0)
        throw new QuotaCapacityInputError('reservation');
    }
    const reserved = reservations.reduce((total, item) => total + item.amount, 0);
    const remaining = request.limit - usage.used - reserved;
    return {
      used: usage.used,
      limit: request.limit,
      reserved,
      remaining,
      allowed: remaining >= request.amount,
    };
  }

  async consume(
    store: QuotaCapacityStore,
    request: QuotaCapacityRequest,
  ): Promise<QuotaCapacitySnapshot> {
    const before = await this.check(store, request);
    // The database predicate remains authoritative even if a writer bypasses the cooperating lock.
    const changed = await store.incrementIfCapacity(
      request,
      request.amount,
      request.limit - before.reserved - request.amount,
    );
    const after = await store.readUsage(request);
    const snapshot = {
      used: after.used,
      limit: request.limit,
      reserved: before.reserved,
      remaining: request.limit - after.used - before.reserved,
      allowed: changed,
    };
    if (!changed) throw new QuotaCapacityExceededError(snapshot, request.amount);
    return snapshot;
  }

  private validate(request: QuotaCapacityRequest): void {
    for (const field of ['subjectId', 'counter', 'period'] as const) {
      if (!request[field]?.trim()) throw new QuotaCapacityInputError(field);
    }
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0)
      throw new QuotaCapacityInputError('amount');
    // Negative limits never mean unlimited. Consumers must explicitly handle their unlimited policy.
    if (!Number.isSafeInteger(request.limit)) throw new QuotaCapacityInputError('limit');
  }
}
