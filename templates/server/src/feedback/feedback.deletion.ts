import type { ApplicationTransaction } from '../database';

/**
 * Structural match of `AccountDeletionContributor` (WP 3.3b, token `ACCOUNT_DELETION_CONTRIBUTORS`),
 * declared here so this feature does not import the accounts folder. Idempotent: a retried deletion
 * job finds nothing left to delete.
 */
export interface FeedbackDeletionContributor {
  readonly name: string;
  readonly order: number;
  erase(tx: ApplicationTransaction, userId: string): Promise<void>;
}

/** Deletes the owner's feedback (messages, page paths and user agents are personal data). */
export const feedbackDeletionContributor: FeedbackDeletionContributor = Object.freeze({
  name: 'feedback',
  order: 50,
  async erase(tx: ApplicationTransaction, userId: string): Promise<void> {
    await tx.query('DELETE FROM "feedback" WHERE "ownerId"=$1', [userId]);
  },
});
