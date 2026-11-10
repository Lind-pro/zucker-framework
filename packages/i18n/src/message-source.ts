import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Logger } from '@nestjs/common';

const LOCALE_TAG = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/;

/**
 * MessageSource — i18n message resolution interface.
 */
export interface MessageSource {
  getMessage(
    code: string,
    args?: unknown[],
    defaultMessage?: string,
    locale?: string,
  ): string;
}

/**
 * FileMessageSource — loads messages from JSON files.
 *
 * Expected file structure: {basePath}/{locale}.json
 * JSON format: flat key-value pairs, e.g. { "error.notFound": "Resource not found" }
 *
 * Supports message interpolation with positional args: "Hello {0}, welcome to {1}"
 */
export class FileMessageSource implements MessageSource {
  private readonly logger = new Logger(FileMessageSource.name);
  private readonly messages = new Map<string, Record<string, string>>();
  private readonly defaultLocale: string;

  constructor(
    private readonly basePath: string,
    options?: { defaultLocale?: string },
  ) {
    this.defaultLocale = options?.defaultLocale ?? 'en';
  }

  getMessage(
    code: string,
    args?: unknown[],
    defaultMessage?: string,
    locale?: string,
  ): string {
    const loc = locale ?? this.defaultLocale;
    const messages = this.loadLocale(loc);
    let message = messages[code];

    // Fall back to default locale
    if (message === undefined && loc !== this.defaultLocale) {
      const defaultMessages = this.loadLocale(this.defaultLocale);
      message = defaultMessages[code];
    }

    if (message === undefined) {
      return defaultMessage ?? code;
    }

    return this.interpolate(message, args);
  }

  private loadLocale(locale: string): Record<string, string> {
    if (this.messages.has(locale)) {
      return this.messages.get(locale)!;
    }

    // The locale names a file: only well-formed BCP 47-like tags are accepted (no path traversal),
    // and misses are not cached so arbitrary caller-supplied values cannot grow the cache.
    if (!LOCALE_TAG.test(locale)) return {};

    const filePath = join(this.basePath, `${locale}.json`);

    if (!existsSync(filePath)) {
      return {};
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content) as Record<string, string>;
      // Flatten nested objects
      const flat = this.flatten(data);
      this.messages.set(locale, flat);
      return flat;
    } catch (err) {
      this.logger.warn(`Failed to load i18n messages for locale "${locale}": ${err instanceof Error ? err.message : String(err)}`);
      this.messages.set(locale, {}); // the file exists: cache the failure instead of re-reading it
      return {};
    }
  }

  private flatten(
    obj: Record<string, unknown>,
    prefix = '',
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(result, this.flatten(value as Record<string, unknown>, fullKey));
      } else {
        result[fullKey] = String(value);
      }
    }
    return result;
  }

  private interpolate(message: string, args?: unknown[]): string {
    if (!args || args.length === 0) return message;
    return message.replace(/\{(\d+)\}/g, (match, index) => {
      const idx = parseInt(index, 10);
      return idx < args.length ? String(args[idx]) : match;
    });
  }

  clearCache(): void {
    this.messages.clear();
  }
}

/**
 * CompositeMessageSource — aggregates multiple message sources.
 * Checks sources in order, returns the first match.
 */
export class CompositeMessageSource implements MessageSource {
  private readonly sources: MessageSource[];

  constructor(sources: MessageSource[]) {
    this.sources = sources;
  }

  getMessage(
    code: string,
    args?: unknown[],
    defaultMessage?: string,
    locale?: string,
  ): string {
    for (const source of this.sources) {
      const message = source.getMessage(code, args, undefined, locale);
      if (message !== code) {
        return message;
      }
    }
    return defaultMessage ?? code;
  }

  addSource(source: MessageSource): void {
    this.sources.push(source);
  }

  /**
   * Add multiple sources at once.
   */
  addSources(sources: MessageSource[]): void {
    this.sources.push(...sources);
  }

  /**
   * Get the number of registered sources.
   */
  getSourceCount(): number {
    return this.sources.length;
  }
}
