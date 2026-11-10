import type { LimiterConfig } from '@zucker-framework/rate-limiter';

/**
 * Credential endpoints (login, registration, email verification, password reset and other
 * account mutations) share a strict per-IP budget against brute force and mail abuse.
 */
export const ACCOUNTS_LIMITER = 'accounts';
/**
 * Cookie refresh, per session (`sid` of a correctly signed refresh token). Every full page load of
 * the admin or web app restores its access token this way, so ordinary browsing must not consume
 * the credential budget. Refresh tokens are unguessable and single-use (rotation + replay denial);
 * this budget only bounds how often one session can be exercised.
 */
export const SESSION_REFRESH_LIMITER = 'session-refresh';
/** Cookie refresh, per client IP: ceiling for invalid/missing cookies and many sessions behind one NAT. */
export const SESSION_REFRESH_NETWORK_LIMITER = 'session-refresh-network';
/** `GET /authorize/me`, per signed-in user: read on every page load, kept apart from `api-default`. */
export const SESSION_READ_LIMITER = 'session-read';

/** Password login, per normalized username + client IP (brute force from one source). */
export const LOGIN_LIMITER = 'login';
/** Password login, per normalized username across every client (distributed guessing); looser to limit lockout abuse. */
export const LOGIN_ACCOUNT_LIMITER = 'login-account';
/** Normalized, bounded login identifier used as the per-account limiter key; undefined for malformed bodies. */
export function loginAccountKey(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const username = (body as Record<string, unknown>).username;
  if (typeof username !== 'string') return undefined;
  const normalized = username.trim().toLowerCase();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

/** Signed payment-provider webhooks, per source address; kept apart from the per-user `billing` budget. */
export const BILLING_WEBHOOK_LIMITER = 'billing-webhook';

/** A named group of limiter budgets (all windows in seconds), exported by the feature that uses them. */
export type RateLimiterFragment = Readonly<Record<string, LimiterConfig>>;
const LIMITER_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Merges limiter fragments into the one map given to `ZuckerRateLimiterModule.forRoot`. A feature
 * declares its budgets in its own folder (`export const X_RATE_LIMITERS = {...}`) and the application
 * passes it here. A name defined twice throws instead of letting one feature silently loosen or
 * tighten another feature's budget.
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

/** Core budgets of this application (accounts, sessions, API keys, billing); features add their own fragments. */
export const APP_RATE_LIMITERS: RateLimiterFragment = composeRateLimiters({
  [ACCOUNTS_LIMITER]: { points: 20, duration: 60 },
  [SESSION_REFRESH_LIMITER]: { points: 60, duration: 60 },
  [SESSION_REFRESH_NETWORK_LIMITER]: { points: 300, duration: 60 },
  [SESSION_READ_LIMITER]: { points: 120, duration: 60 },
  'api-key': { points: 60, duration: 60, blockDuration: 0 },
  billing: { points: 60, duration: 60 },
  // Signed provider callbacks; signature verification is the real gate, this only bounds abuse per source.
  [BILLING_WEBHOOK_LIMITER]: { points: 600, duration: 60 },
  [LOGIN_LIMITER]: { points: 5, duration: 900 }, // failed logins per account + IP per 15 minutes
  [LOGIN_ACCOUNT_LIMITER]: { points: 30, duration: 900 }, // failed logins per account per 15 minutes
  'api-default': { points: 100, duration: 60 }, // 每分钟100次API调用
});
