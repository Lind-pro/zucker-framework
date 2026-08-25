import { describe, expect, it } from 'vitest';
import { ZuckerAuthModule } from './auth.module';

describe('ZuckerAuthModule controller registration', () => {
  it('keeps framework controllers enabled by default', () => {
    const moduleDefinition = ZuckerAuthModule.forRoot({
      jwtSecret: 'unit-test-jwt-secret',
    });

    expect(moduleDefinition.controllers).toHaveLength(3);
  });

  it('allows products to suppress unused framework controllers', () => {
    const moduleDefinition = ZuckerAuthModule.forRoot({
      jwtSecret: 'unit-test-jwt-secret',
      registerControllers: false,
    });

    expect(moduleDefinition.controllers).toEqual([]);
  });

  it('supports controller suppression for async registration', () => {
    const moduleDefinition = ZuckerAuthModule.forRootAsync({
      registerControllers: false,
      useFactory: () => ({
        jwtSecret: 'unit-test-jwt-secret',
      }),
    });

    expect(moduleDefinition.controllers).toEqual([]);
  });
});
