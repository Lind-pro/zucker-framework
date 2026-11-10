import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Injectable,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';

const localeStorage = new AsyncLocalStorage<string>();

/**
 * LocaleContext -- uses AsyncLocalStorage to bind the current locale
 * to the execution context (request scope).
 */
export class LocaleContext {
  private static defaultLocale = 'en';

  static setDefault(locale: string): void {
    this.defaultLocale = locale;
  }

  static getCurrent(): string {
    return localeStorage.getStore() ?? this.defaultLocale;
  }

  static run<T>(locale: string, fn: () => T): T {
    return localeStorage.run(locale, fn);
  }

  static runAsync<T>(locale: string, fn: () => Promise<T>): Promise<T> {
    return localeStorage.run(locale, fn);
  }
}

/**
 * NestJS interceptor that sets the locale from the Accept-Language header.
 */
@Injectable()
export class LocaleInterceptor implements NestInterceptor {
  private readonly supportedLocales: Set<string>;
  private readonly defaultLocale: string;
  /** Normalized full tag (lower case, `-` separated) -> configured locale. */
  private readonly byTag = new Map<string, string>();
  /** Primary subtag -> first configured locale with that language. */
  private readonly byPrimary = new Map<string, string>();

  constructor(options?: { supportedLocales?: string[]; defaultLocale?: string }) {
    this.supportedLocales = new Set(options?.supportedLocales ?? ['en', 'zh']);
    for (const locale of this.supportedLocales) {
      const key = normalizeTag(locale);
      if (!this.byTag.has(key)) this.byTag.set(key, locale);
      const primary = key.split('-')[0];
      if (!this.byPrimary.has(primary)) this.byPrimary.set(primary, locale);
    }
    this.defaultLocale = options?.defaultLocale ?? 'en';
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const acceptLanguage: string =
      (request.headers?.['accept-language'] as string) ?? '';
    const locale = this.parseLocale(acceptLanguage);

    // Wrap the entire Observable subscription inside AsyncLocalStorage.run
    // so the locale context is available during data emission, not just creation.
    return new Observable((subscriber) => {
      LocaleContext.runAsync(locale, async () => {
        return new Promise<void>((resolve, reject) => {
          next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (err) => {
              subscriber.error(err);
              reject(err);
            },
            complete: () => {
              subscriber.complete();
              resolve();
            },
          });
        });
      }).catch((err) => subscriber.error(err));
    });
  }

  private parseLocale(header: string): string {
    if (!header) return this.defaultLocale;

    // Parse Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8
    const parts = header.split(',').map((part, index) => {
      const [lang, q] = part.trim().split(';q=');
      const quality = q ? parseFloat(q) : 1;
      return { tag: normalizeTag(lang ?? ''), quality: Number.isFinite(quality) ? quality : 0, index };
    });

    parts.sort((a, b) => b.quality - a.quality || a.index - b.index);

    // Highest quality first; per range, an exact (region-qualified) match beats a language-only one.
    for (const { tag, quality } of parts) {
      if (quality <= 0 || !tag) continue;
      const primary = tag.split('-')[0];
      const match = this.byTag.get(tag) ?? this.byTag.get(primary) ?? this.byPrimary.get(primary);
      if (match) return match;
    }

    return this.defaultLocale;
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/_/g, '-').toLowerCase();
}
