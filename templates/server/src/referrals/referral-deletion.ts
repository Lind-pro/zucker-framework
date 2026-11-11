import type { ApplicationTransaction } from '../database';
import type { ReferralDeletionContributor } from './referral.tokens';

/**
 * Account deletion (WP 3.3b contract): removes the user's own code (so the link stops working) and
 * the binding in which the user is the referee. Bindings where the user is the referrer stay, they
 * belong to the other users' history (the pending reward is then skipped as `referrer-unavailable`).
 * `referral_rewards` rows stay: they hold only ids and frozen amounts and back the ledger grants.
 * Low `order` on purpose: it runs before contributors that take credit-account locks.
 */
export const referralDeletionContributor: ReferralDeletionContributor = Object.freeze({
  name: 'referrals',
  order: 10,
  async erase(tx: ApplicationTransaction, userId: string): Promise<void> {
    await tx.query('DELETE FROM referral_codes WHERE "userId" = $1', [userId]);
    await tx.query('DELETE FROM referral_bindings WHERE "refereeId" = $1', [userId]);
  },
});
