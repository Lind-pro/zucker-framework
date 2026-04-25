import type { MessageSource } from './message-source';
import { LocaleContext } from './locale-context';

/**
 * I18nSpec — supports nested i18n parameter resolution.
 *
 * Allows i18n message codes whose arguments themselves need i18n resolution.
 *
 * Reference: jetlinks I18nSpec
 *
 * @example
 * ```ts
 * const spec = I18nSpec.of('message.scene.term.full_name', 'Property: {0}/{1}',
 *   'Temperature',
 *   I18nSpec.of('message.property.recent', 'Current Value'),
 * );
 * const resolved = spec.resolve(messageSource);
 * // => "Property: Temperature/Current Value" (or localized)
 * ```
 */
export class I18nSpec {
  /** i18n message code; if empty, defaultMessage is returned as-is */
  code?: string;
  /** Fallback message when code is not found or not provided */
  defaultMessage?: string;
  /** Nested i18n-aware arguments */
  args: I18nSpec[];

  constructor(code?: string, defaultMessage?: string, args: I18nSpec[] = []) {
    this.code = code;
    this.defaultMessage = defaultMessage;
    this.args = args;
  }

  /**
   * Create an I18nSpec with optional nested args.
   * Args can be strings (treated as plain defaults) or I18nSpec instances.
   */
  static of(
    code: string,
    defaultMessage?: string,
    ...args: Array<string | I18nSpec>
  ): I18nSpec {
    const specArgs = args.map((arg) => {
      if (typeof arg === 'string') {
        return new I18nSpec(undefined, arg);
      }
      return arg;
    });
    return new I18nSpec(code, defaultMessage, specArgs);
  }

  /**
   * Add a nested i18n argument.
   */
  withArg(code: string, defaultMessage?: string, ...args: Array<string | I18nSpec>): this {
    this.args.push(I18nSpec.of(code, defaultMessage, ...args));
    return this;
  }

  /**
   * Add an existing I18nSpec as a nested argument.
   */
  withArgSpec(spec: I18nSpec): this {
    this.args.push(spec);
    return this;
  }

  /**
   * Resolve this spec to a final message using the given MessageSource.
   * Recursively resolves nested args first.
   */
  resolve(messageSource: MessageSource, locale?: string): string {
    const currentLocale = locale ?? LocaleContext.getCurrent();

    if (this.args.length === 0) {
      return this.resolveMessage(messageSource, currentLocale);
    }

    // Recursively resolve all args
    const resolvedArgs = this.args.map((arg) => arg.resolve(messageSource, currentLocale));

    return this.resolveMessage(messageSource, currentLocale, resolvedArgs);
  }

  /**
   * Create a shallow copy of this spec.
   */
  copy(): I18nSpec {
    return new I18nSpec(
      this.code,
      this.defaultMessage,
      this.args.map((a) => a.copy()),
    );
  }

  private resolveMessage(
    messageSource: MessageSource,
    locale: string,
    resolvedArgs?: string[],
  ): string {
    if (!this.code) {
      return this.defaultMessage ?? '';
    }
    return messageSource.getMessage(
      this.code,
      resolvedArgs,
      this.defaultMessage,
      locale,
    );
  }
}
