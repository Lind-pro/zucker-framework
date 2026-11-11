import type { RateLimiterFragment } from '../../rate-limits';

/**
 * Second-factor guesses per account (login step-up, confirm, disable, recovery-code regeneration),
 * across every client and every factor. Spent before the factor is checked and refunded on success,
 * so it bounds wrong codes and recovery codes on top of the per-process TOTP lockout, and it is shared
 * across replicas when the rate limiter uses Redis.
 */
export const TWO_FACTOR_LIMITER = 'two-factor';
/** Back-office actions on another account's security settings (admin 2FA reset), per acting admin. */
export const ACCOUNT_SECURITY_ADMIN_LIMITER = 'account-security-admin';

export const ACCOUNT_SECURITY_RATE_LIMITERS: RateLimiterFragment = {
  [TWO_FACTOR_LIMITER]: { points: 10, duration: 900 },
  [ACCOUNT_SECURITY_ADMIN_LIMITER]: { points: 20, duration: 3600 },
};
