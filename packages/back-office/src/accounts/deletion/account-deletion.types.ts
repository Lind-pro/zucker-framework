import type { InjectionToken } from '@nestjs/common';
import type { DatabaseAdapter } from '@zucker-framework/core';

/**
 * One feature's share of account deletion. Every feature that stores personal data of a user
 * registers one. Structural contract (no base class), so feature folders need not import the host.
 *
 * - `erase` runs inside the single deletion transaction, in ascending `order`, before `users` is
 *   anonymised. It must be idempotent: a failed attempt rolls everything back and the job retries the
 *   whole set. Throw (any error) to postpone the deletion, e.g. while the user still has running work.
 *   Financial records (orders, subscriptions, refunds, ledger journal) are retained, never erased.
 * - `onScheduled` (optional) runs inside the transaction that schedules the deletion, after sessions
 *   and API keys are revoked; use it to stop queued work through the feature's public service.
 * - `afterCommit` (optional) runs after the erase transaction committed (best effort, logged, never
 *   undoes the deletion); use it for external cleanup such as storage objects.
 *
 * `Tx` is the consumer's transaction adapter (the host passes what `DatabaseAdapter.$transaction` gives).
 */
export interface AccountDeletionContributor<Tx = DatabaseAdapter> {
  readonly name: string;
  readonly order: number;
  erase(tx: Tx, userId: string): Promise<void>;
  onScheduled?(tx: Tx, userId: string): Promise<void>;
  afterCommit?(userId: string): Promise<void>;
}

/** A contributor built by Nest (so it can use another feature's public service). */
export interface AccountDeletionContributorProvider {
  inject?: InjectionToken[];
  useFactory: (...dependencies: never[]) => AccountDeletionContributor<never> | Promise<AccountDeletionContributor<never>>;
}

/** Thrown by a contributor to postpone execution (the job retries later); never shown to the user. */
export class AccountDeletionPostponedError extends Error {
  constructor(readonly contributor: string, reason: string) {
    super(`Account deletion postponed by ${contributor}: ${reason}`);
    this.name = 'AccountDeletionPostponedError';
  }
}

/** Sorts by `order` (then name) and refuses duplicate names or invalid entries at start-up. */
export function orderContributors<Tx>(contributors: readonly AccountDeletionContributor<Tx>[]): readonly AccountDeletionContributor<Tx>[] {
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
