/**
 * Wall clock of the account-security flows (TOTP steps and lockout, ticket expiry, recent
 * authentication, deletion grace). `AccountModule` provides the system clock; tests override the token
 * (`.overrideProvider(ACCOUNT_SECURITY_CLOCK).useValue(() => fixedDate)`).
 */
export const ACCOUNT_SECURITY_CLOCK = Symbol('ACCOUNT_SECURITY_CLOCK');
export type AccountSecurityClock = () => Date;
export const systemAccountSecurityClock: AccountSecurityClock = () => new Date();

/** Recent authentication for password-less accounts: the session must be at most this old. */
export const RECENT_SESSION_MS = 10 * 60_000;
