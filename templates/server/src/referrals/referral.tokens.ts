import type { ApplicationTransaction } from '../database';

/**
 * Optional notification port, bound by the integration WP (for example to the inbox emitter). It is
 * called inside the reward transaction, once per party that received credits, under a savepoint: a
 * failing notifier is logged and never undoes the reward. `eventKey` is stable per reward and party
 * (`referral:<orderId>:referrer|referee`), so a notifier can de-duplicate on it.
 */
export interface ReferralRewardNotice {
  userId: string;
  credits: number;
  role: 'referrer' | 'referee';
  eventKey: string;
  /** Same value as `eventKey`; the field name `inboxReferralNotifier` (WP 3.2) de-duplicates on. */
  rewardId: string;
  /** The qualifying order of the referee. */
  orderId: string;
}
export interface ReferralNotifier {
  notifyReward(tx: ApplicationTransaction, notice: ReferralRewardNotice): Promise<void>;
}
export const REFERRAL_NOTIFIER = Symbol('REFERRAL_NOTIFIER');

/** Process options of the referral feature (read once from the environment). */
export interface ReferralOptions {
  /** Origin of the public website (`WEB_URL`) used to build share links; null leaves `link` empty. */
  webOrigin: string | null;
  /** Injected clock for tests; defaults to the system clock. */
  now?: () => Date;
}
export const REFERRAL_OPTIONS = Symbol('REFERRAL_OPTIONS');

export function referralOptionsFromEnvironment(env: Readonly<Record<string, string | undefined>>): ReferralOptions {
  let webOrigin: string | null = null;
  try {
    const url = env.WEB_URL?.trim() ? new URL(env.WEB_URL.trim()) : null;
    if (url && (url.protocol === 'https:' || url.protocol === 'http:')) webOrigin = url.origin;
  } catch { webOrigin = null; }
  return { webOrigin };
}

/**
 * Structural contract of an account-deletion contributor (WP 3.3b owns the token
 * `ACCOUNT_DELETION_CONTRIBUTORS`); declared here so this feature compiles on its own.
 */
export interface ReferralDeletionContributor {
  name: string;
  order: number;
  erase(tx: ApplicationTransaction, userId: string): Promise<void>;
}
