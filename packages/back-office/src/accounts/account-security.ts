import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { RateLimiterService, TooManyRequestsException } from '@zucker-framework/rate-limiter';

/**
 * Stable machine-readable codes of the account-security endpoints. Responses keep the shared error
 * envelope `{ status, code, message, result: { reason, details? } }` (HttpExceptionFilter), so clients
 * branch on `code` and never on the message text.
 */
export const ACCOUNT_SECURITY_ERRORS = {
  /** 503: no usable TOTP encryption key; enrolment and enrolled sign-in fail closed. */
  twoFactorUnavailable: 'TWO_FACTOR_UNAVAILABLE',
  /** 403: account policy `twoFactorEnabled` is off (new enrolments only). */
  twoFactorDisabled: 'TWO_FACTOR_DISABLED',
  twoFactorAlreadyEnabled: 'TWO_FACTOR_ALREADY_ENABLED',
  twoFactorNotEnabled: 'TWO_FACTOR_NOT_ENABLED',
  twoFactorNotPending: 'TWO_FACTOR_NOT_PENDING',
  /** 400: staff cannot reset their own two-factor; the owner flow (with a factor) applies. */
  twoFactorResetSelf: 'TWO_FACTOR_RESET_SELF',
  /** 403: only a superadmin may reset a superadmin's two-factor. */
  twoFactorResetForbidden: 'TWO_FACTOR_RESET_FORBIDDEN',
  /** 401 at the login step, 400 on account endpoints: wrong, replayed or locked-out code. */
  twoFactorCodeInvalid: 'TWO_FACTOR_CODE_INVALID',
  /** 400: challenge unknown, expired, consumed or of another purpose. */
  twoFactorChallengeInvalid: 'TWO_FACTOR_CHALLENGE_INVALID',
  recentAuthenticationRequired: 'RECENT_AUTHENTICATION_REQUIRED',
  recentAuthenticationFailed: 'RECENT_AUTHENTICATION_FAILED',
  magicLinkDisabled: 'MAGIC_LINK_DISABLED',
  deletionDisabled: 'ACCOUNT_DELETION_DISABLED',
  /** 403 on every sign-in path while a deletion is scheduled; `details.executeAfter` (ISO). */
  deletionPending: 'ACCOUNT_DELETION_PENDING',
  deletionConfirmMismatch: 'ACCOUNT_DELETION_CONFIRM_MISMATCH',
  hasActiveSubscription: 'ACCOUNT_HAS_ACTIVE_SUBSCRIPTION',
  hasOpenRefund: 'ACCOUNT_HAS_OPEN_REFUND',
  lastSuperadmin: 'ACCOUNT_LAST_SUPERADMIN',
  deletionNotPending: 'ACCOUNT_DELETION_NOT_PENDING',
  /** 400: wrong or expired six-digit code (verification mode `'code'`). */
  verificationCodeInvalid: 'VERIFICATION_CODE_INVALID',
  /** 429: too many wrong codes; `details.retryAfter` (seconds). */
  verificationLocked: 'VERIFICATION_LOCKED',
  /** 503: the attempt store is unavailable; codes fail closed. */
  verificationUnavailable: 'VERIFICATION_UNAVAILABLE',
} as const;
export type AccountSecurityErrorCode = typeof ACCOUNT_SECURITY_ERRORS[keyof typeof ACCOUNT_SECURITY_ERRORS];

type ExceptionClass = new (body: Record<string, unknown>) => HttpException;
const CLASSES: Record<number, ExceptionClass> = {
  400: BadRequestException, 401: UnauthorizedException, 403: ForbiddenException, 404: NotFoundException,
  409: ConflictException, 503: ServiceUnavailableException,
};

export function accountSecurityError(status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: AccountSecurityErrorCode, message: string,
  details?: Record<string, string | number | boolean>): HttpException {
  const body = { code, message, reason: code, ...(details ? { details } : {}) };
  return status === 429 ? new HttpException(body, 429) : new CLASSES[status]!(body);
}

/** Wall clock of the account-security flows; tests override `ACCOUNTS_CLOCK`. */
export type AccountSecurityClock = () => Date;
export const systemAccountSecurityClock: AccountSecurityClock = () => new Date();
/** Recent authentication for password-less accounts: the session must be at most this old. */
export const RECENT_SESSION_MS = 10 * 60_000;

/** Request shape the account controllers read (`user` is set by `AccountGuard` on authenticated routes). */
export interface AccountRequest {
  ip?: string;
  headers: { cookie?: string; origin?: string; 'sec-fetch-site'?: string; [name: string]: string | string[] | undefined };
  user: { id: string; sid: string; username?: string };
}

/** Browser mutations need a trusted `Origin` and must not be a cross-site fetch. */
export function assertAccountOrigin(origins: ReadonlySet<string>, req: { headers: { origin?: string | string[]; 'sec-fetch-site'?: string | string[] } }): void {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origins.has(origin) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new ForbiddenException('Untrusted account request origin');
  }
}

/** Exact-key string body (each value at most `max` characters); anything else is 400. `undefined`/`null` body = `{}`. */
export function stringFields(body: unknown, keys: readonly string[], max = 2048): Record<string, string> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid request');
  const entries = Object.entries(body);
  if (entries.some(([key, value]) => !keys.includes(key) || typeof value !== 'string' || value.length > max)) {
    throw new BadRequestException('Invalid request fields');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
/** Like `stringFields`, but a missing body is 400 (account credential endpoints). */
export function requiredFields(body: unknown, keys: readonly string[]): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid request');
  return stringFields(body, keys);
}

/**
 * Spends one point of each configured limiter (skipping limiters a narrow composition does not
 * configure) and returns a refund callback for the success path.
 */
export async function spendBudgets(limiter: RateLimiterService, budgets: ReadonlyArray<readonly [string, string]>): Promise<() => Promise<void>> {
  const keys = budgets.filter(([name]) => limiter.has(name));
  for (const [name, key] of keys) {
    try { await limiter.consume(name, key); }
    catch (error) {
      if (error instanceof TooManyRequestsException) throw new TooManyRequestsException('Too many requests', error.retryAfter);
      throw error;
    }
  }
  return async () => { await Promise.all(keys.map(([name, key]) => limiter.reward(name, key).catch(() => undefined))); };
}

export function emailAddress(value: string | undefined): string {
  const email = value?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Invalid email');
  return email;
}
