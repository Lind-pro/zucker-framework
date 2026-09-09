import type { MessageSource } from './message-source';
import { LocaleContext } from './locale-context';

// ---------------------------------------------------------------------------
// Standalone formatting functions
// ---------------------------------------------------------------------------

/**
 * Format a message template with positional or named parameters.
 *
 * Supports positional arguments `{0}, {1}` and named arguments `{name}, {count}`.
 *
 * @example formatMessage('Hello {0}, you have {1} messages', ['Alice', 5])
 * @example formatMessage('Hello {name}, you have {count} messages', { name: 'Alice', count: 5 })
 */
export function formatMessage(
  template: string,
  params: unknown[] | Record<string, unknown>,
): string {
  if (Array.isArray(params)) {
    return template.replace(/\{(\d+)\}/g, (match, index) => {
      const idx = parseInt(index, 10);
      return idx < params.length ? String(params[idx]) : match;
    });
  }
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return key in params ? String(params[key]) : match;
  });
}

/**
 * Simple plural selection (ICU MessageFormat style).
 *
 * Chooses among `zero`, `one` and `other` forms based on `count`.
 * The selected form is then interpolated with `{count}` replaced by the actual
 * number (formatted according to `locale` when provided).
 *
 * @example pluralize(0, { zero: '没有消息', one: '1 条消息', other: '{count} 条消息' })
 * @example pluralize(5, { zero: '没有消息', one: '1 条消息', other: '{count} 条消息' })
 */
export function pluralize(
  count: number,
  forms: { zero?: string; one?: string; other: string },
  locale?: string,
): string {
  let form: string;
  if (count === 0 && forms.zero !== undefined) {
    form = forms.zero;
  } else if (count === 1 && forms.one !== undefined) {
    form = forms.one;
  } else {
    form = forms.other;
  }

  const loc = locale ?? LocaleContext.getCurrent();
  const formatted = new Intl.NumberFormat(loc).format(count);
  return form.replace(/\{count\}/g, formatted);
}

/**
 * Format a date using `Intl.DateTimeFormat`.
 *
 * @param date   Date instance or epoch-milliseconds timestamp
 * @param style  Predefined date style — `'short'`, `'medium'` (default),
 *               `'long'` or `'full'`
 * @param locale BCP-47 locale tag; defaults to the current context locale
 */
export function formatDate(
  date: Date | number,
  style: 'short' | 'medium' | 'long' | 'full' = 'medium',
  locale?: string,
): string {
  const loc = locale ?? LocaleContext.getCurrent();
  const d = typeof date === 'number' ? new Date(date) : date;
  return new Intl.DateTimeFormat(loc, { dateStyle: style }).format(d);
}

/**
 * Format a number using `Intl.NumberFormat`.
 *
 * @param value   The numeric value
 * @param style   `'decimal'` (default), `'currency'` or `'percent'`
 * @param options Additional options — currently only `currency` (ISO 4217 code,
 *                required when `style` is `'currency'`)
 * @param locale  BCP-47 locale tag; defaults to the current context locale
 */
export function formatNumber(
  value: number,
  style: 'decimal' | 'currency' | 'percent' = 'decimal',
  options?: { currency?: string },
  locale?: string,
): string {
  const loc = locale ?? LocaleContext.getCurrent();
  const opts: Intl.NumberFormatOptions = { style };
  if (style === 'currency') {
    opts.currency = options?.currency ?? 'USD';
  }
  return new Intl.NumberFormat(loc, opts).format(value);
}

/**
 * Format a date as a human-friendly relative time string
 * (e.g. "3 hours ago", "in 2 days") using `Intl.RelativeTimeFormat`.
 *
 * @param date   Date instance or epoch-milliseconds timestamp
 * @param locale BCP-47 locale tag; defaults to the current context locale
 */
export function formatRelativeTime(
  date: Date | number,
  locale?: string,
): string {
  const loc = locale ?? LocaleContext.getCurrent();
  const d = typeof date === 'number' ? new Date(date) : date;
  const diffMs = d.getTime() - Date.now();

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['week', 7 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ];

  const rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });

  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms) {
      const value = Math.round(diffMs / ms);
      return rtf.format(value, unit);
    }
  }
  return rtf.format(0, 'second');
}

// ---------------------------------------------------------------------------
// LocaleUtils class
// ---------------------------------------------------------------------------

/**
 * LocaleUtils — static utility for i18n message resolution.
 *
 * Provides convenient methods for resolving messages using the current locale
 * context and a configured MessageSource.
 */
export class LocaleUtils {
  private static messageSource: MessageSource | null = null;

  /**
   * Set the global message source used by resolve helpers.
   */
  static setMessageSource(source: MessageSource): void {
    this.messageSource = source;
  }

  /**
   * Get the currently configured global message source.
   */
  static getMessageSource(): MessageSource | null {
    return this.messageSource;
  }

  /**
   * Resolve a message using the current locale context.
   */
  static resolveMessage(code: string, ...args: unknown[]): string {
    return this.resolveMessageWithDefault(code, code, ...args);
  }

  /**
   * Resolve a message with a default fallback using the current locale context.
   */
  static resolveMessageWithDefault(
    code: string,
    defaultMessage: string,
    ...args: unknown[]
  ): string {
    if (!this.messageSource) {
      return defaultMessage;
    }
    const locale = LocaleContext.getCurrent();
    return this.messageSource.getMessage(code, args, defaultMessage, locale);
  }

  /**
   * Resolve a message using a specific MessageSource and the current locale.
   */
  static resolveMessageFrom(
    source: MessageSource,
    code: string,
    defaultMessage?: string,
    ...args: unknown[]
  ): string {
    const locale = LocaleContext.getCurrent();
    return source.getMessage(code, args, defaultMessage, locale);
  }

  /**
   * Resolve a message using a specific locale (ignoring the context locale).
   */
  static resolveMessageForLocale(
    code: string,
    locale: string,
    defaultMessage?: string,
    ...args: unknown[]
  ): string {
    if (!this.messageSource) {
      return defaultMessage ?? code;
    }
    return this.messageSource.getMessage(code, args, defaultMessage, locale);
  }

  /**
   * Execute a function within a specific locale context.
   */
  static doWith<T>(locale: string, fn: () => T): T {
    return LocaleContext.run(locale, fn);
  }

  /**
   * Execute an async function within a specific locale context.
   */
  static doWithAsync<T>(locale: string, fn: () => Promise<T>): Promise<T> {
    return LocaleContext.runAsync(locale, fn);
  }

  /**
   * Get the current locale.
   */
  static current(): string {
    return LocaleContext.getCurrent();
  }
}
