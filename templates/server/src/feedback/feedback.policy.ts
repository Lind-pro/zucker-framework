import { definePolicy, type PolicyDefinition } from '@zucker-framework/back-office/settings';

export interface FeedbackPolicyValues {
  [key: string]: boolean | number;
  /** Public: the web console hides the form when false; `POST /feedback` answers 403 `FEEDBACK_DISABLED`. */
  enabled: boolean;
  /** Open + in-progress items one user may have at a time; checked inside the insert transaction. */
  maxOpenPerUser: number;
}

/**
 * Feedback switches, hot-applied through the policy store (`/management/policies/feedback`).
 * Pin with `POLICY_FEEDBACK_ENABLED` / `POLICY_FEEDBACK_MAX_OPEN_PER_USER`.
 */
export const FEEDBACK_POLICY = definePolicy<FeedbackPolicyValues>({
  id: 'feedback',
  name: 'Feedback',
  fields: [
    { key: 'enabled', type: 'boolean', default: true, public: true, label: 'Accept feedback',
      description: 'Off hides the feedback form; existing feedback and replies stay visible to their owners.' },
    { key: 'maxOpenPerUser', type: 'number', default: 20, min: 1, max: 1000, integer: true, label: 'Open feedback per user',
      description: 'Maximum open or in-progress items per user; further submissions are refused until staff resolve or close one.' },
  ],
});

export const FEEDBACK_POLICIES: readonly PolicyDefinition[] = [FEEDBACK_POLICY];
