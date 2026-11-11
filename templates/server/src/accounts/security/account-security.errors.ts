import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

/**
 * Stable machine-readable codes of the account-security endpoints. Responses keep the shared error
 * envelope `{ status, code, message, result: { reason, details? } }` (HttpExceptionFilter), so clients
 * branch on `code` and never on the message text.
 */
export const ACCOUNT_SECURITY_ERRORS = {
  /** 503: CONFIG_ENCRYPTION_KEY missing/invalid; enrolment and enrolled sign-in fail closed. */
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
} as const;
export type AccountSecurityErrorCode = typeof ACCOUNT_SECURITY_ERRORS[keyof typeof ACCOUNT_SECURITY_ERRORS];

type ExceptionClass = new (body: Record<string, unknown>) => HttpException;
const CLASSES: Record<number, ExceptionClass> = {
  400: BadRequestException, 401: UnauthorizedException, 403: ForbiddenException, 404: NotFoundException,
  409: ConflictException, 503: ServiceUnavailableException,
};

export function accountSecurityError(status: 400 | 401 | 403 | 404 | 409 | 503, code: AccountSecurityErrorCode, message: string,
  details?: Record<string, string | number | boolean>): HttpException {
  return new CLASSES[status]!({ code, message, reason: code, ...(details ? { details } : {}) });
}
