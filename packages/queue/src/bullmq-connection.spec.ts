import { bullMqConnectionFromUrl } from './bullmq-connection';

describe('bullMqConnectionFromUrl', () => {
  it('parses authentication, port and database for a producer', () => {
    expect(bullMqConnectionFromUrl('redis://user:p%40ss@redis.internal:6380/4')).toEqual({
      host: 'redis.internal',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 4,
      tls: undefined,
      maxRetriesPerRequest: 1,
    });
  });

  it('enables TLS and worker-compatible retries for rediss', () => {
    expect(
      bullMqConnectionFromUrl('rediss://secure.example.com', { role: 'worker' }),
    ).toMatchObject({
      host: 'secure.example.com',
      port: 6379,
      db: 0,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('rejects unsupported protocols and invalid database numbers', () => {
    expect(() => bullMqConnectionFromUrl('http://localhost:6379')).toThrow('redis://');
    expect(() => bullMqConnectionFromUrl('redis://localhost/not-a-db')).toThrow('non-negative');
  });
});
