import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';
import { defineConfig, mergeConfigs, loadFromEnv, safeParseConfig } from './typed-config';

describe('defineConfig', () => {
  it('should create a Zod object schema', () => {
    const schema = defineConfig({
      port: z.number().default(3000),
      host: z.string().default('localhost'),
    });

    const result = schema.parse({});
    expect(result.port).toBe(3000);
    expect(result.host).toBe('localhost');
  });

  it('should validate nested config', () => {
    const schema = defineConfig({
      jwt: z.object({
        secret: z.string().min(8),
        expiresIn: z.string().default('7d'),
      }),
    });

    const result = schema.parse({ jwt: { secret: 'my-secret-key' } });
    expect(result.jwt.expiresIn).toBe('7d');
  });

  it('should fail validation for invalid config', () => {
    const schema = defineConfig({
      jwt: z.object({
        secret: z.string().min(8),
      }),
    });

    expect(() => schema.parse({ jwt: { secret: 'short' } })).toThrow();
  });
});

describe('mergeConfigs', () => {
  it('should merge flat objects', () => {
    const result = mergeConfigs<Record<string, unknown>>(
      { a: 1, b: 2 },
      { b: 3, c: 4 },
    );
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('should deep merge nested objects', () => {
    const result = mergeConfigs<Record<string, unknown>>(
      { db: { host: 'localhost', port: 5432 } },
      { db: { port: 3306 } },
    );
    expect(result).toEqual({ db: { host: 'localhost', port: 3306 } });
  });

  it('should handle undefined layers', () => {
    const result = mergeConfigs<Record<string, unknown>>(
      { a: 1 },
      undefined,
      { b: 2 },
    );
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('should not deep-merge arrays (replace)', () => {
    const result = mergeConfigs<Record<string, unknown>>(
      { tags: ['a', 'b'] },
      { tags: ['c'] },
    );
    expect(result).toEqual({ tags: ['c'] });
  });

  it('should support 3+ layers (priority: last wins)', () => {
    const result = mergeConfigs<Record<string, unknown>>(
      { env: 'dev', port: 3000 },
      { port: 4000 },
      { port: 5000, env: 'prod' },
    );
    expect(result).toEqual({ env: 'prod', port: 5000 });
  });
});

describe('loadFromEnv', () => {
  it('should extract prefixed env vars into nested object', () => {
    const env = {
      APP__JWT__SECRET: 'my-secret',
      APP__JWT__EXPIRES_IN: '7d',
      APP__DATABASE__MAX_CONNECTIONS: '10',
      UNRELATED: 'ignored',
    };

    const result = loadFromEnv('APP', env);
    expect(result).toEqual({
      jwt: {
        secret: 'my-secret',
        expiresIn: '7d',
      },
      database: {
        maxConnections: '10',
      },
    });
  });

  it('should handle empty prefix match', () => {
    const result = loadFromEnv('APP', {});
    expect(result).toEqual({});
  });

  it('should convert snake_case to camelCase', () => {
    const env = { APP__SOME_NESTED__DEEP_KEY: 'value' };
    const result = loadFromEnv('APP', env);
    expect(result).toEqual({ someNested: { deepKey: 'value' } });
  });
});

describe('safeParseConfig', () => {
  const schema = z.object({
    port: z.number(),
    host: z.string(),
  });

  it('should return success for valid data', () => {
    const result = safeParseConfig(schema, { port: 3000, host: 'localhost' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.port).toBe(3000);
    }
  });

  it('should return errors for invalid data', () => {
    const result = safeParseConfig(schema, { port: 'not-a-number', host: 123 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
