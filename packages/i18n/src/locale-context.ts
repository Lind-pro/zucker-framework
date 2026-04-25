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

  constructor(options?: { supportedLocales?: string[]; defaultLocale?: string }) {
    this.supportedLocales = new Set(options?.supportedLocales ?? ['en', 'zh']);
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
    const parts = header.split(',').map((part) => {
      const [lang, q] = part.trim().split(';q=');
      return {
        lang: lang.trim().split('-')[0].toLowerCase(),
        quality: q ? parseFloat(q) : 1,
      };
    });

    parts.sort((a, b) => b.quality - a.quality);

    for (const { lang } of parts) {
      if (this.supportedLocales.has(lang)) {
        return lang;
      }
    }

    return this.defaultLocale;
  }
}
