/**
 * 错误码常量
 */
export const ErrorCodes = {
  ILLEGAL_ARGUMENT: 'illegal_argument',
  TIMEOUT: 'timeout',
  UNSUPPORTED: 'unsupported',
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not_found',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
