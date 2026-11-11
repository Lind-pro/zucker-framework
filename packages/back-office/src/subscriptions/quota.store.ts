import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '@zucker-framework/core';
import {
  QuotaCapacity, QuotaCapacityExceededError, QuotaReservationError, ResourceChargeError, UNLIMITED_QUOTA,
  type QuotaCapacityKey, type QuotaCapacityStore, type QuotaReservationInput, type QuotaReservationRecord,
  type QuotaReservationState, type QuotaReservationStore, type ResourceChargeLookup,
} from '@zucker-framework/credit';
import { isUniqueViolation, type QuotaChargeIdentity, type SubscriptionsModels, type SubscriptionsStorage } from './storage';

export interface StoredQuotaReservation extends QuotaReservationRecord {
  /** Null only on rows stored before policy capture (see `SubscriptionsQuotaPolicy.legacyPolicy`). */
  period: string | null; limit: number | null; policyVersion: string; resourceType: string; resourceId: string;
  createdAt: Date; updatedAt: Date; finishedAt: Date | null; reason: string | null;
}
export interface CapturedQuotaInput extends QuotaReservationInput {
  id: string; period: string; limit: number; policyVersion: string; resourceType: string; resourceId: string;
}
const capacity = new QuotaCapacity();
const MAX_COUNTER = 2147483647;

/**
 * Storage key of a RESERVED/CONFIRMED reservation: sha256 of the length-prefixed UTF-8 parts. A
 * migration backfill of existing rows must compute the same value; keep both in sync.
 */
export function activeResourceKey(identity: { subjectId: string; counter: string; resourceType: string; resourceId: string }): string {
  const parts = [identity.subjectId, identity.counter, identity.resourceType, identity.resourceId];
  return createHash('sha256').update(parts.map(part => `${Buffer.byteLength(part)}:${part}`).join(''), 'utf8').digest('hex');
}
function key(identity: QuotaCapacityKey) { return { subjectId: identity.subjectId, counter: identity.counter, period: identity.period }; }

async function readUsage(models: SubscriptionsModels, identity: QuotaCapacityKey) {
  const rows = await models.quotaUsage.findMany({ where: key(identity), select: { used: true, limit: true }, take: 1 }) as unknown as Array<{ used: number; limit: number }>;
  return rows[0] ?? null;
}
/**
 * Create-or-update of the usage row's limit, never resetting `used`. Callers hold the quota lock of
 * this subject/counter, so the read-then-insert cannot race another writer of the same row.
 */
async function ensureUsage(models: SubscriptionsModels, identity: QuotaCapacityKey, limit: number) {
  const changed = await models.quotaUsage.updateMany({ where: key(identity), data: { limit, updatedAt: new Date() } });
  if (!changed.count) await models.quotaUsage.create({ data: { ...key(identity), limit, used: 0, updatedAt: new Date() } });
  const usage = await readUsage(models, identity);
  if (!usage) throw new Error('Quota usage disappeared inside the transaction');
  return usage;
}

/** `QuotaCapacity` binding on one transaction; the caller holds the subject/counter lock. */
export function createQuotaCapacityStore(tx: DatabaseAdapter, storage: SubscriptionsStorage): QuotaCapacityStore {
  const models = storage.of(tx);
  return {
    lock: identity => storage.locks.quota(tx, identity),
    ensureUsage: (identity, limit) => ensureUsage(models, identity, limit),
    readUsage: async identity => {
      const usage = await readUsage(models, identity);
      if (!usage) throw new Error('Quota usage disappeared inside the transaction');
      return usage;
    },
    reservations: async identity => await models.quotaReservations.findMany({ where: { ...key(identity), status: 'RESERVED' },
      select: { amount: true, expiresAt: true, period: true } }) as unknown as Array<{ amount: number; expiresAt: Date; period: string }>,
    incrementIfCapacity: async (identity, amount, maximumUsedBefore) => (await models.quotaUsage.updateMany({
      where: { ...key(identity), used: { lte: maximumUsedBefore } }, data: { used: { increment: amount }, updatedAt: new Date() } })).count === 1,
  };
}

export interface QuotaReservationStoreOptions {
  /** Reuse a caller transaction. */
  transaction?: DatabaseAdapter;
  /** Restrict `expire()` to this reservation (targeted maintenance). */
  expiryId?: string;
  /**
   * Accept the explicit unlimited plan quota (`-1`): no capacity check, but usage is still recorded
   * (with limit `-1`). Off by default: a fixed-limit counter never treats `-1` as unlimited.
   */
  allowUnlimited?: boolean;
}

/**
 * `QuotaReservationService` / `ResourceChargeService` store over a `DatabaseAdapter`. Counter usage is
 * separate from any credit wallet; every writer takes the same subject/counter lock.
 */
export function createQuotaReservationStore(database: DatabaseAdapter, storage: SubscriptionsStorage, options: QuotaReservationStoreOptions = {}):
QuotaReservationStore<DatabaseAdapter, StoredQuotaReservation, CapturedQuotaInput> {
  return {
    transaction: work => options.transaction ? work(options.transaction) : database.$transaction(work),
    lock: (tx, identity) => storage.locks.quota(tx, identity),
    find: async (tx, id) => await storage.of(tx).quotaReservations.findUnique({ where: { id } }) as unknown as StoredQuotaReservation | null,
    assertCapacity: async (tx, input) => {
      if (options.allowUnlimited && input.limit === UNLIMITED_QUOTA) {
        await ensureUsage(storage.of(tx), input, UNLIMITED_QUOTA);
        return;
      }
      const snapshot = await capacity.check(createQuotaCapacityStore(tx, storage), { ...input, now: new Date() });
      if (!snapshot.allowed) throw new QuotaCapacityExceededError(snapshot, input.amount);
    },
    insert: async (tx, input) => {
      const policy = storage.quota;
      const keyed = !!input.resourceType && !!input.resourceId && (policy.chargeOnce?.(input) ?? true);
      try {
        return await storage.of(tx).quotaReservations.create({ data: {
          ...policy.insertExtras?.({ subjectId: input.subjectId, counter: input.counter, resourceType: input.resourceType,
            resourceId: input.resourceId, period: input.period, limit: input.limit, amount: input.amount }),
          id: input.id, subjectId: input.subjectId, counter: input.counter,
          period: input.period, amount: input.amount, limit: input.limit, policyVersion: input.policyVersion,
          resourceType: input.resourceType, resourceId: input.resourceId, expiresAt: input.expiresAt, status: 'RESERVED',
          activeResourceKey: keyed ? activeResourceKey(input) : null } }) as unknown as StoredQuotaReservation;
      } catch (error) {
        // Another live charge holds this resource's key (all writers of the key hold the
        // subject/counter lock, so this means a row written outside the reservation path).
        if (keyed && isUniqueViolation(error)) throw new ResourceChargeError('in_progress', 'This resource already has an active charge');
        if (isUniqueViolation(error)) throw new QuotaReservationError('conflict');
        throw error;
      }
    },
    transition: async (tx, id, from, to, transition) => {
      const policy = storage.quota;
      const reservations = storage.of(tx).quotaReservations;
      const current = policy.transitionExtras ? await reservations.findUnique({ where: { id } }) : null;
      return (await reservations.updateMany({
        where: { id, status: from, ...(transition.expiresAfter ? { expiresAt: { gt: transition.expiresAfter } } : {}) },
        data: {
          ...policy.transitionExtras?.({ to, at: transition.at, reason: transition.reason ?? null, current }),
          status: to, updatedAt: transition.at, finishedAt: transition.at, reason: transition.reason ?? null,
          // RELEASED/EXPIRED free the resource key so a later attempt can charge it again (a partial
          // unique index over live rows may keep it as history instead).
          ...((to === 'RELEASED' || to === 'EXPIRED') && policy.clearKeyOnFinish !== false ? { activeResourceKey: null } : {}),
        },
      })).count === 1;
    },
    charge: async (tx, reservation) => {
      const policy = storage.quota;
      const models = storage.of(tx);
      // Rows stored before policy capture charge with the product's legacy policy.
      const captured = reservation.period !== null && reservation.limit !== null;
      let period = reservation.period, limit = reservation.limit;
      if (period === null || limit === null) {
        if (!policy.legacyPolicy) throw new Error('Reservation has no captured period/limit and no legacy policy is configured');
        ({ period, limit } = await policy.legacyPolicy(tx, { ...reservation }));
      }
      const identity = { subjectId: reservation.subjectId, counter: reservation.counter, period };
      // An active reservation already owns capacity. Converting it to usage keeps used+reserved
      // unchanged and must not invalidate an accepted operation after a later policy change.
      const changed = await models.quotaUsage.updateMany({
        where: { ...identity, used: { lte: MAX_COUNTER - reservation.amount } },
        data: { used: { increment: reservation.amount }, updatedAt: new Date() },
      });
      if (changed.count !== 1) {
        if (captured || (await readUsage(models, identity))) throw new Error('Captured quota usage is unavailable');
        await models.quotaUsage.create({ data: { ...identity, limit, used: reservation.amount, updatedAt: new Date() } });
      }
      await policy.charged?.(tx, { ...identity, amount: reservation.amount });
    },
    expire: async (tx, before) => (await storage.of(tx).quotaReservations.updateMany({
      where: { ...(options.expiryId ? { id: options.expiryId } : {}), status: 'RESERVED', expiresAt: { lt: before } },
      data: { ...storage.quota.transitionExtras?.({ to: 'EXPIRED', at: before, reason: 'reservation-expired', current: null }),
        status: 'EXPIRED' satisfies QuotaReservationState, finishedAt: before, updatedAt: before, reason: 'reservation-expired',
        ...(storage.quota.clearKeyOnFinish !== false ? { activeResourceKey: null } : {}) },
    })).count,
  };
}

/**
 * Prior-charge lookup: a CONFIRMED or live RESERVED row of exactly this subject, counter and resource,
 * or of a configured legacy resource type of it (on any counter). Matches by fields, so keyed and
 * unkeyed rows count alike. Runs on the reservation transaction after the subject/counter lock.
 */
export function createResourceChargeLookup(storage: SubscriptionsStorage): ResourceChargeLookup<DatabaseAdapter> {
  const exact = (query: QuotaChargeIdentity) =>
    ({ subjectId: query.subjectId, counter: query.counter, resourceType: query.resourceType, resourceId: query.resourceId });
  return {
    async findActiveCharge(tx, query) {
      const legacy = storage.quota.legacyResourceTypes?.[query.resourceType] ?? [];
      const rows = await storage.of(tx).quotaReservations.findMany({ where: {
        subjectId: query.subjectId, resourceId: query.resourceId,
        ...(query.exceptReservationId ? { id: { not: query.exceptReservationId } } : {}),
        AND: [
          { OR: [{ counter: query.counter, resourceType: query.resourceType }, ...(legacy.length ? [{ resourceType: { in: [...legacy] } }] : [])] },
          { OR: [{ status: 'CONFIRMED' }, { status: 'RESERVED', expiresAt: { gt: query.now } }] },
        ],
      }, select: { status: true } }) as unknown as Array<{ status: 'CONFIRMED' | 'RESERVED' }>;
      if (rows.some(row => row.status === 'CONFIRMED')) return 'CONFIRMED';
      return rows.length ? 'RESERVED' : null;
    },
    async expireStale(tx, query) {
      return (await storage.of(tx).quotaReservations.updateMany({
        where: { ...exact(query), status: 'RESERVED', expiresAt: { lte: query.now } },
        data: { ...storage.quota.transitionExtras?.({ to: 'EXPIRED', at: query.now, reason: 'reservation-expired', current: null }),
          status: 'EXPIRED', finishedAt: query.now, updatedAt: query.now, reason: 'reservation-expired',
          ...(storage.quota.clearKeyOnFinish !== false ? { activeResourceKey: null } : {}) },
      })).count;
    },
  };
}

export interface QuotaCounterUsage { used: number; reserved: number }
/** Used and live-reserved amounts of one subject/counter/period (no lock; a read for display). */
export async function quotaCounterUsage(database: DatabaseAdapter, storage: SubscriptionsStorage,
  identity: QuotaCapacityKey, now = new Date()): Promise<QuotaCounterUsage> {
  const models = storage.of(database);
  const [usage, reserved] = await Promise.all([
    readUsage(models, identity),
    models.quotaReservations.findMany({ where: { ...key(identity), status: 'RESERVED', expiresAt: { gt: now } }, select: { amount: true } }) as unknown as Promise<Array<{ amount: number }>>,
  ]);
  return { used: usage?.used ?? 0, reserved: reserved.reduce((sum, row) => sum + row.amount, 0) };
}

export interface QuotaReservationPage { data: StoredQuotaReservation[]; total: number; page: number; pageSize: number }
/** A subject's reservations, newest first. */
export async function listQuotaReservations(database: DatabaseAdapter, storage: SubscriptionsStorage, subjectId: string,
  page: { page: number; pageSize: number }): Promise<QuotaReservationPage> {
  const models = storage.of(database);
  const where = { subjectId };
  const [data, total] = await Promise.all([
    models.quotaReservations.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page.page - 1) * page.pageSize, take: page.pageSize }) as unknown as Promise<StoredQuotaReservation[]>,
    models.quotaReservations.count({ where }),
  ]);
  return { data, total, ...page };
}
/** One reservation of this subject, or null (another subject's id reads as missing). */
export async function findQuotaReservation(database: DatabaseAdapter, storage: SubscriptionsStorage, subjectId: string, id: string) {
  const rows = await storage.of(database).quotaReservations.findMany({ where: { id, subjectId }, take: 1 }) as unknown as StoredQuotaReservation[];
  return rows[0] ?? null;
}
