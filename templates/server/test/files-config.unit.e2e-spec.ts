import { describe, expect, it } from 'vitest';
import { storageOptionsFromEnvironment } from '../src/files/files.config';

// WP 4.3: production needs https S3 endpoints; FILES_S3_INTERNAL_HTTP only opens plain http to a
// single-label host on a private container network (the compose file's http://minio:9000).
const base = { NODE_ENV: 'production', FILES_STORAGE_PROVIDER: 's3', FILES_S3_BUCKET: 'app-files',
  FILES_S3_ACCESS_KEY_ID: 'synthetic-access', FILES_S3_SECRET_ACCESS_KEY: 'synthetic-secret' };

describe('private S3 endpoint in production', () => {
  it('accepts https and refuses http by default', () => {
    expect(storageOptionsFromEnvironment({ ...base, FILES_S3_ENDPOINT: 'https://s3.example.com' })).toMatchObject({ provider: 's3' });
    expect(() => storageOptionsFromEnvironment({ ...base, FILES_S3_ENDPOINT: 'http://minio:9000' })).toThrow('Invalid private S3 endpoint');
  });
  it('FILES_S3_INTERNAL_HTTP=true allows http only to a single-label host', () => {
    const env = { ...base, FILES_S3_INTERNAL_HTTP: 'true' };
    expect(storageOptionsFromEnvironment({ ...env, FILES_S3_ENDPOINT: 'http://minio:9000' })).toMatchObject({ endpoint: 'http://minio:9000' });
    for (const endpoint of ['http://s3.example.com', 'http://203.0.113.5:9000', 'http://minio.internal:9000'])
      expect(() => storageOptionsFromEnvironment({ ...env, FILES_S3_ENDPOINT: endpoint }), endpoint).toThrow('Invalid private S3 endpoint');
    expect(() => storageOptionsFromEnvironment({ ...base, FILES_S3_INTERNAL_HTTP: 'yes', FILES_S3_ENDPOINT: 'http://minio:9000' })).toThrow();
  });
});
