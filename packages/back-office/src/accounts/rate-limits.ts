import type { LimiterConfig } from '@zucker-framework/rate-limiter';
import { ACCOUNT_LOGIN_IDENTIFIER_FIELDS, type AccountLoginIdentifier } from './accounts.options';

/**
 * Credential endpoints (login, registration, email verification, password reset and other
 * account mutations) share a strict per-IP budget against brute force and mail abuse.
 */
export const ACCOUNTS_LIMITER = 'accounts';
/**
 * Cookie refresh, per session (`sid` of a correctly signed refresh token). Every full page load
 * restores its access token this way, so ordinary browsing must not consume the credential budget.
 */
export const SESSION_REFRESH_LIMITER = 'session-refresh';
/** Cookie refresh, per client IP: ceiling for invalid/missing cookies and many sessions behind one NAT. */
export const SESSION_REFRESH_NETWORK_LIMITER = 'session-refresh-network';
/** `GET /authorize/me`, per signed-in user: read on every page load, kept apart from `api-default`. */
export const SESSION_READ_LIMITER = 'session-read';
/** Password login, per normalized login identifier + client IP (brute force from one source). */
export const LOGIN_LIMITER = 'login';
/** Password login, per normalized login identifier across every client (distributed guessing); looser to limit lockout abuse. */
export const LOGIN_ACCOUNT_LIMITER = 'login-account';
/** Second-factor guesses per account (login step-up, confirm, disable, recovery-code regeneration). */
export const TWO_FACTOR_LIMITER = 'two-factor';
/** Back-office actions on another account's security settings (admin 2FA reset), per acting admin. */
export const ACCOUNT_SECURITY_ADMIN_LIMITER = 'account-security-admin';
/** Requests per API key (`ApiKeyService` rate limit). */
export const API_KEY_LIMITER = 'api-key';
/** General per-user/per-IP budget of read endpoints; the consumer configures it (it is shared with other features). */
export const API_DEFAULT_LIMITER = 'api-default';

/**
 * Normalized (trimmed, lower-cased), bounded login identifier used as the per-account limiter key, read
 * from the body field of the configured identifier option (`username`, `email` or `login`); undefined for
 * malformed bodies. Addresses are normalized the same way the lookup normalizes them, so case variants
 * of one address share one budget.
 */
export function loginAccountKey(body: unknown, identifier: AccountLoginIdentifier = 'username'): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[ACCOUNT_LOGIN_IDENTIFIER_FIELDS[identifier] ?? 'username'];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

/** A named group of limiter budgets (all windows in seconds), exported by the feature that uses them. */
export type RateLimiterFragment = Readonly<Record<string, LimiterConfig>>;
const LIMITER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Merges limiter fragments into the one map given to `ZuckerRateLimiterModule.forRoot`. A name defined
 * twice throws instead of letting one feature silently loosen or tighten another feature's budget.
 */
export function composeRateLimiters(...fragments: readonly RateLimiterFragment[]): RateLimiterFragment {
  const result: Record<string, LimiterConfig> = {};
  for (const fragment of fragments) {
    for (const [name, config] of Object.entries(fragment)) {
      if (!LIMITER_NAME.test(name)) throw new Error(`Invalid rate limiter name ${name}`);
      if (Object.hasOwn(result, name)) throw new Error(`Rate limiter ${name} is defined more than once`);
      if (!Number.isSafeInteger(config.points) || config.points < 1 || !Number.isSafeInteger(config.duration) || config.duration < 1)
        throw new Error(`Rate limiter ${name} needs positive integer points and duration`);
      result[name] = { ...config };
    }
  }
  return Object.freeze(result);
}

/** Budgets of the core account routes (sign-in, sessions, credential mail). `api-default` is the consumer's. */
export const ACCOUNT_RATE_LIMITS: RateLimiterFragment = composeRateLimiters({
  [ACCOUNTS_LIMITER]: { points: 20, duration: 60 },
  [SESSION_REFRESH_LIMITER]: { points: 60, duration: 60 },
  [SESSION_REFRESH_NETWORK_LIMITER]: { points: 300, duration: 60 },
  [SESSION_READ_LIMITER]: { points: 120, duration: 60 },
  [LOGIN_LIMITER]: { points: 5, duration: 900 }, // failed logins per account + IP per 15 minutes
  [LOGIN_ACCOUNT_LIMITER]: { points: 30, duration: 900 }, // failed logins per account per 15 minutes
});
/** Two-factor guesses per account and back-office security actions per admin (feature `twoFactor`). */
export const ACCOUNT_SECURITY_RATE_LIMITS: RateLimiterFragment = composeRateLimiters({
  [TWO_FACTOR_LIMITER]: { points: 10, duration: 900 },
  [ACCOUNT_SECURITY_ADMIN_LIMITER]: { points: 20, duration: 3600 },
});
/** Per-key request budget (feature `apiKeys`); the key's own `rateLimit` is the effective ceiling. */
export const ACCOUNT_API_KEY_RATE_LIMITS: RateLimiterFragment = composeRateLimiters({
  [API_KEY_LIMITER]: { points: 60, duration: 60, blockDuration: 0 },
});
