import { definePolicy, type PolicyDefinition } from '@zucker-framework/back-office/settings';
import type { PolicyService } from '@zucker-framework/back-office/settings';

/** Effective values of the `referral` policy (see `REFERRAL_POLICY`). */
export interface ReferralPolicyValues {
  [key: string]: boolean | number;
  enabled: boolean;
  /** Credits for the user who shared the code, per rewarded referee. */
  referrerCredits: number;
  /** Credits for the referred user, granted together with the referrer's. */
  refereeCredits: number;
  /** 0 = reward credits never expire; otherwise days from the grant. */
  rewardValidDays: number;
  /** A code can be claimed only by an account created at most this many days ago. */
  claimWindowDays: number;
  /** The qualifying order must be this old (and unrefunded) before anything is granted. */
  rewardDelayDays: number;
  /** 0 = unlimited granted rewards per referrer. */
  maxRewardsPerReferrer: number;
}

export const MAX_REFERRAL_CREDITS = 1_000_000;

/**
 * Built-in "invite a friend" programme, hot-applied through the policy store. Off by default
 * (decision D15) with a 7-day reward delay, so a refund or charge-back inside the delay prevents the
 * reward. Only `enabled` is public (the web console hides the invitation when it is off). Amounts are
 * frozen into the reward row when it is granted: changing them later never alters past rewards.
 * Pin any field with `POLICY_REFERRAL_<FIELD>`.
 */
export const REFERRAL_POLICY = definePolicy<ReferralPolicyValues>({
  id: 'referral',
  name: 'Referral programme',
  fields: [
    { key: 'enabled', type: 'boolean', default: false, public: true, label: 'Enable the referral programme',
      description: 'Off by default. Not available while Affonso or PromoteKit is enabled for the website.' },
    { key: 'referrerCredits', type: 'number', default: 0, min: 0, max: MAX_REFERRAL_CREDITS, integer: true, label: 'Credits for the referrer' },
    { key: 'refereeCredits', type: 'number', default: 0, min: 0, max: MAX_REFERRAL_CREDITS, integer: true, label: 'Credits for the referred user' },
    { key: 'rewardValidDays', type: 'number', default: 0, min: 0, max: 3650, integer: true, label: 'Reward validity (days, 0 = never expire)' },
    { key: 'claimWindowDays', type: 'number', default: 7, min: 1, max: 365, integer: true, label: 'Claim window after sign-up (days)' },
    { key: 'rewardDelayDays', type: 'number', default: 7, min: 0, max: 365, integer: true, label: 'Reward delay after the first paid order (days)',
      description: 'The order must be this old and have no refund evidence before credits are granted.' },
    { key: 'maxRewardsPerReferrer', type: 'number', default: 0, min: 0, max: 100_000, integer: true, label: 'Maximum rewards per referrer (0 = unlimited)' },
  ],
  validate(values) {
    if (values.enabled && values.referrerCredits < 1 && values.refereeCredits < 1)
      throw new Error('Enable the referral programme only with a positive credit amount for the referrer or the referred user');
  },
});

/** Policies contributed by the referrals feature, appended to `PolicyModule.forRoot({ policies })`. */
export const REFERRAL_POLICIES: readonly PolicyDefinition[] = [REFERRAL_POLICY];

const DEFAULTS: ReferralPolicyValues = Object.freeze(Object.fromEntries(
  REFERRAL_POLICY.fields.map(field => [field.key, field.default]),
)) as ReferralPolicyValues;

/** Effective policy; compositions without the policy registered get the defaults (programme off). */
export async function readReferralPolicy(policies: PolicyService | undefined): Promise<ReferralPolicyValues> {
  if (!policies || !policies.ids().includes(REFERRAL_POLICY.id)) return DEFAULTS;
  return policies.get(REFERRAL_POLICY);
}
