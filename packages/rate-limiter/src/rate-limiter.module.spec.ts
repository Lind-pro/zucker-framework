import { APP_GUARD } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ZuckerRateLimiterModule } from './rate-limiter.module';

function hasGlobalGuard(
  providers: NonNullable<ReturnType<typeof ZuckerRateLimiterModule.forRoot>['providers']>,
) {
  return providers.some(
    (provider) =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === APP_GUARD,
  );
}

describe('ZuckerRateLimiterModule guard registration', () => {
  it('registers the global guard by default', () => {
    const definition = ZuckerRateLimiterModule.forRoot({ limiters: {} });
    expect(hasGlobalGuard(definition.providers ?? [])).toBe(true);
  });

  it('supports local guard registration for sync and async configuration', () => {
    const syncDefinition = ZuckerRateLimiterModule.forRoot({
      globalGuard: false,
      limiters: {},
    });
    const asyncDefinition = ZuckerRateLimiterModule.forRootAsync({
      globalGuard: false,
      useFactory: () => ({ limiters: {} }),
    });

    expect(hasGlobalGuard(syncDefinition.providers ?? [])).toBe(false);
    expect(hasGlobalGuard(asyncDefinition.providers ?? [])).toBe(false);
  });
});
