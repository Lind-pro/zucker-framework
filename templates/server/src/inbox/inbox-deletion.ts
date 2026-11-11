import type { ApplicationTransaction } from '../database';

/**
 * Account-deletion contributor (structural contract of WP 3.3b `ACCOUNT_DELETION_CONTRIBUTORS`):
 * removes every notification of the user. Idempotent. `InboxService.emit` refuses anonymised
 * (`deleted-…`) recipients, so events processed after the erase cannot recreate rows.
 */
export const inboxDeletionContributor = Object.freeze({
  name: 'inbox',
  order: 60,
  async erase(tx: ApplicationTransaction, userId: string): Promise<void> {
    await tx.query('DELETE FROM inbox_notifications WHERE "userId" = $1', [userId]);
  },
});
