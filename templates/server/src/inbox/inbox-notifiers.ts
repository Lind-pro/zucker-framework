import { Logger } from '@nestjs/common';
import type { ApplicationTransaction } from '../database';
import type { InboxService } from './inbox.service';

/**
 * Adapters from other features' optional notifier ports to `InboxService.emit`. They are structural
 * (no import from those features), so the integration module binds them without cross-imports:
 *
 *   { provide: FEEDBACK_NOTIFIER, inject: [InboxService], useFactory: inboxFeedbackNotifier }
 *   { provide: REFERRAL_NOTIFIER, inject: [InboxService], useFactory: inboxReferralNotifier }
 *
 * Both run inside the caller's transaction, so the notification commits or rolls back with the
 * business change. They never throw for a recipient that no longer exists (emit skips it).
 */
export interface FeedbackReplyNotice { userId: string; feedbackId: string }
export interface ReferralRewardNotice {
  userId: string;
  credits: number;
  /**
   * Stable id of the reward (e.g. the rewarded order id or the referee id). Required for
   * idempotency: the same reward announced twice yields one notification per recipient.
   */
  rewardId?: string;
  /** Same as rewardId when that is not supplied (WP 3.5a rewards are unique per order). */
  orderId?: string;
}

export function inboxFeedbackNotifier(inbox: InboxService) {
  return {
    /** One notification per feedback item; a later edited reply does not announce again. */
    async notifyReply(tx: ApplicationTransaction | undefined, notice: FeedbackReplyNotice): Promise<void> {
      await inbox.emit(tx, { userId: notice.userId, eventKey: `feedback-reply:${notice.feedbackId}`, type: 'feedback.replied',
        href: '/account/feedback' });
    },
  };
}

export function inboxReferralNotifier(inbox: InboxService) {
  const logger = new Logger('InboxReferralNotifier');
  return {
    async notifyReward(tx: ApplicationTransaction | undefined, notice: ReferralRewardNotice): Promise<void> {
      const key = notice.rewardId ?? notice.orderId;
      if (!key) {
        // Without a stable id the announcement could repeat on a retried grant; skip rather than fail the grant.
        logger.warn('Referral reward notification skipped: no rewardId/orderId supplied');
        return;
      }
      await inbox.emit(tx, { userId: notice.userId, eventKey: `referral-reward:${key}`, type: 'referral.rewarded',
        params: { credits: notice.credits }, href: '/account/referrals' });
    },
  };
}
