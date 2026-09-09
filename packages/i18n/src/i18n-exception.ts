import { BusinessException } from '@zucker-framework/core';

/**
 * I18nException — an exception whose message is resolved via i18n at response time.
 *
 * Stores a message code and interpolation args. The actual i18n resolution
 * happens when getMessage() is called (typically in an exception filter).
 */
export class I18nException extends BusinessException {
  readonly i18nCode: string;
  readonly i18nArgs: unknown[];

  constructor(code: string, args: unknown[] = [], fallbackMessage?: string) {
    super(fallbackMessage ?? code, code);
    this.i18nCode = code;
    this.i18nArgs = args;
  }
}
