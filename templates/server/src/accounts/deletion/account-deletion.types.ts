import type { ApplicationTransaction } from '../../database';

/**
 * One feature's share of account deletion. Contributors form a registry (`ACCOUNT_DELETION_CONTRIBUTORS`)
 * that `AccountDeletionModule.forRoot({ contributors })` extends; every feature that stores personal data
 * of a user registers one. Structural contract (no base class), so feature folders do not import this one.
 *
 * - `erase` runs inside the single deletion transaction, in ascending `order`, before `users` is
 *   anonymised. It must be idempotent: a failed attempt rolls everything back and the job retries the
 *   whole set. Throw (any error) to postpone the deletion, e.g. while the user still has running work.
 *   Financial records (orders, subscriptions, refunds, ledger journal) are retained, never erased.
 * - `onScheduled` (optional) runs inside the transaction that schedules the deletion, after sessions
 *   and API keys are revoked; use it to stop queued work through the feature's public service.
 * - `afterCommit` (optional) runs after the erase transaction committed (best effort, logged, never
 *   undoes the deletion); use it for external cleanup such as storage objects.
 */
export interface AccountDeletionContributor {
  readonly name: string;
  readonly order: number;
  erase(tx: ApplicationTransaction, userId: string): Promise<void>;
  onScheduled?(tx: ApplicationTransaction, userId: string): Promise<void>;
  afterCommit?(userId: string): Promise<void>;
}

/** Ordered, de-duplicated contributor list (built-ins + `forRoot({ contributors })`). */
export const ACCOUNT_DELETION_CONTRIBUTORS = Symbol('ACCOUNT_DELETION_CONTRIBUTORS');

/** Thrown by a contributor to postpone execution (the job retries later); never shown to the user. */
export class AccountDeletionPostponedError extends Error {
  constructor(readonly contributor: string, reason: string) {
    super(`Account deletion postponed by ${contributor}: ${reason}`);
    this.name = 'AccountDeletionPostponedError';
  }
}

/** Sorts by `order` (then name) and refuses duplicate names or invalid entries at start-up. */
export function orderContributors(contributors: readonly AccountDeletionContributor[]): readonly AccountDeletionContributor[] {
  const names = new Set<string>();
  for (const contributor of contributors) {
    if (!contributor || typeof contributor.name !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(contributor.name)
      || !Number.isFinite(contributor.order) || typeof contributor.erase !== 'function') {
      throw new Error('Invalid account deletion contributor');
    }
    if (names.has(contributor.name)) throw new Error(`Account deletion contributor ${contributor.name} is registered twice`);
    names.add(contributor.name);
  }
  return Object.freeze([...contributors].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)));
}
