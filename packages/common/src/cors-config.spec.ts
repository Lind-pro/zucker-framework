import { describe, expect, it } from 'vitest';
import { buildCorsOptions, DEFAULT_CORS_CONFIG } from './cors-config';

describe('buildCorsOptions', () => {
  it('never combines the default wildcard origin with credentials', () => {
    const options = buildCorsOptions({ enable: true });
    expect(options && options.origin).toBe(true);
    expect(options && options.credentials).toBe(false);
  });

  it('drops credentials for an explicit wildcard unless the dangerous opt-in is set', () => {
    const plain = buildCorsOptions({ enable: true, configs: [{ allowedOrigins: ['*'], allowCredentials: true }] });
    expect(plain && plain.credentials).toBe(false);
    const optIn = buildCorsOptions({
      enable: true,
      configs: [{ allowedOrigins: ['*'], allowCredentials: true, allowAnyOriginWithCredentials: true }],
    });
    expect(optIn && optIn.credentials).toBe(true);
  });

  it('keeps credentials for an explicit origin list', () => {
    const options = buildCorsOptions({ enable: true, configs: [{ allowedOrigins: ['https://app.example'] }] });
    expect(options && options.origin).toEqual(['https://app.example']);
    expect(options && options.credentials).toBe(true);
  });

  it('allows the REST verbs used by generated CRUD routes and lists headers explicitly', () => {
    const options = buildCorsOptions({ enable: true });
    expect(options && options.methods).toEqual(expect.arrayContaining(['PUT', 'PATCH', 'DELETE']));
    expect(options && options.allowedHeaders).not.toContain('*');
    expect(options && options.allowedHeaders).toContain('Authorization');
  });
  it('lists the request headers read by framework packages in the default allowed headers (N-M12)', () => {
    const options = buildCorsOptions({ enable: true });
    expect(options && options.allowedHeaders).toEqual(
      expect.arrayContaining(['X-Tenant-ID', 'X-API-Key', 'Idempotency-Key', 'X-Verify-Code', 'X-Auth-Token', 'X-Token']),
    );
    expect(DEFAULT_CORS_CONFIG.allowedHeaders).toEqual(
      expect.arrayContaining(['X-Tenant-ID', 'X-API-Key', 'Idempotency-Key', 'X-Verify-Code', 'X-Auth-Token', 'X-Token']),
    );
  });
});
