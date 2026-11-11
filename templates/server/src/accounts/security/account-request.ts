import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RateLimiterService, TooManyRequestsException } from '@zucker-framework/rate-limiter';

/** Request shape the account-security controllers read (set by AccountGuard on authenticated routes). */
export interface AccountSecurityRequest {
  ip?: string;
  headers: { cookie?: string; origin?: string; 'sec-fetch-site'?: string };
  user: { id: string; sid: string; username?: string };
}

/** Same trusted-origin rule as the account controller (`ACCOUNT_ORIGINS`, no cross-site fetch). */
export function accountOrigins(): ReadonlySet<string> {
  return new Set((process.env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()));
}
export function assertAccountOrigin(origins: ReadonlySet<string>, req: Pick<AccountSecurityRequest, 'headers'>): void {
  if (!req.headers.origin || !origins.has(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new ForbiddenException('Untrusted account request origin');
  }
}

/** Exact-key string body (each value at most `max` characters); anything else is 400. */
export function stringFields(body: unknown, keys: readonly string[], max = 2048): Record<string, string> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid request');
  const entries = Object.entries(body);
  if (entries.some(([key, value]) => !keys.includes(key) || typeof value !== 'string' || value.length > max)) {
    throw new BadRequestException('Invalid request fields');
  }
  return Object.fromEntries(entries) as Record<string, string>;
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
