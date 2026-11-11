import { ACCOUNT_API_KEY_RATE_LIMITS, ACCOUNT_RATE_LIMITS, composeRateLimiters, type RateLimiterFragment } from '@zucker-framework/back-office/accounts';

export {
  ACCOUNTS_LIMITER, SESSION_REFRESH_LIMITER, SESSION_REFRESH_NETWORK_LIMITER, SESSION_READ_LIMITER, LOGIN_LIMITER, LOGIN_ACCOUNT_LIMITER,
  loginAccountKey, composeRateLimiters, type RateLimiterFragment,
} from '@zucker-framework/back-office/accounts';

/** Signed payment-provider webhooks, per source address; kept apart from the per-user `billing` budget. */
export const BILLING_WEBHOOK_LIMITER = 'billing-webhook';

/** Core budgets of this application (account host, API keys, billing); features add their own fragments. */
export const APP_RATE_LIMITERS: RateLimiterFragment = composeRateLimiters(ACCOUNT_RATE_LIMITS, ACCOUNT_API_KEY_RATE_LIMITS, {
  billing: { points: 60, duration: 60 },
  // Signed provider callbacks; signature verification is the real gate, this only bounds abuse per source.
  [BILLING_WEBHOOK_LIMITER]: { points: 600, duration: 60 },
  'api-default': { points: 100, duration: 60 },
});
