import { describe, expect, it } from 'vitest';
import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { LocaleContext, LocaleInterceptor } from './locale-context';

async function resolve(interceptor: LocaleInterceptor, header?: string): Promise<string> {
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ headers: header === undefined ? {} : { 'accept-language': header } }) }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(null).pipe() };
  let seen = '';
  const handler: CallHandler = {
    handle: () => {
      seen = LocaleContext.getCurrent();
      return next.handle();
    },
  };
  await lastValueFrom(interceptor.intercept(context, handler), { defaultValue: null });
  return seen;
}

describe('LocaleInterceptor', () => {
  it('keeps language-only behaviour for the default locales', async () => {
    const interceptor = new LocaleInterceptor();
    expect(await resolve(interceptor, 'zh-CN,zh;q=0.9')).toBe('zh');
    expect(await resolve(interceptor, 'fr')).toBe('en');
  });

  it('selects region-qualified supported locales, case-insensitively', async () => {
    const interceptor = new LocaleInterceptor({ supportedLocales: ['zh-CN', 'zh-TW', 'en-US'], defaultLocale: 'en-US' });
    expect(await resolve(interceptor, 'zh-tw,zh;q=0.9')).toBe('zh-TW');
    expect(await resolve(interceptor, 'zh_CN')).toBe('zh-CN');
    expect(await resolve(interceptor, 'zh-HK')).toBe('zh-CN');
    expect(await resolve(interceptor, 'de,en;q=0.5')).toBe('en-US');
  });

  it('honours quality order and ignores q=0', async () => {
    const interceptor = new LocaleInterceptor({ supportedLocales: ['en-US', 'zh-CN'] });
    expect(await resolve(interceptor, 'en;q=0.4,zh-CN;q=0.8')).toBe('zh-CN');
    expect(await resolve(interceptor, 'zh-CN;q=0,en')).toBe('en-US');
  });
});
