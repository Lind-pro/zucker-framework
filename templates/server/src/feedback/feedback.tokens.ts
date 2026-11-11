import type { ApplicationTransaction } from '../database';

/**
 * Optional port: tells another feature (the in-app inbox, WP 3.2) that staff replied. Called inside
 * the reply's transaction, so a throwing notifier rolls the reply back; implementations should only
 * insert rows. Bound by the integration WP through `FeedbackModule.forRoot({ notifier })`.
 */
export interface FeedbackNotifier {
  notifyReply(tx: ApplicationTransaction, event: { userId: string; feedbackId: string }): Promise<void>;
}
export const FEEDBACK_NOTIFIER = Symbol('FEEDBACK_NOTIFIER');
