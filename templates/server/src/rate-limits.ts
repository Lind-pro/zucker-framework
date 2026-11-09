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

/** Rate-limit policy of this application (all windows in seconds). */
export const APP_RATE_LIMITERS: Readonly<Record<string, LimiterConfig>> = {
  [ACCOUNTS_LIMITER]: { points: 20, duration: 60 },
  [SESSION_REFRESH_LIMITER]: { points: 60, duration: 60 },
  [SESSION_REFRESH_NETWORK_LIMITER]: { points: 300, duration: 60 },
  [SESSION_READ_LIMITER]: { points: 120, duration: 60 },
  'api-key': { points: 60, duration: 60, blockDuration: 0 },
  billing: { points: 60, duration: 60 },
  login: { points: 5, duration: 900 }, // 15分钟最多5次登录
  'api-default': { points: 100, duration: 60 }, // 每分钟100次API调用
};
