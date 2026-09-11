import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createPostgresConnectionErrorHandler,
  postgresIdleInTransactionSessionOptions,
  readPositiveIntegerConfiguration,
  registerPostgresPoolErrorHandler,
} from './postgres-connection-safety';

describe('PostgreSQL connection safety', () => {
  it('builds injection-safe startup settings and accepts explicit configuration', () => {
    expect(readPositiveIntegerConfiguration('POOL_MAX', 4, undefined)).toBe(4);
    expect(readPositiveIntegerConfiguration('POOL_MAX', 4, '12')).toBe(12);
    expect(postgresIdleInTransactionSessionOptions(45000)).toBe(
      '-c timezone=UTC -c idle_in_transaction_session_timeout=45000',
    );
    for (const input of ['0', '-1', '1.5', '45000 -c search_path=private', 'invalid']) {
      expect(() => readPositiveIntegerConfiguration('POOL_MAX', 4, input)).toThrow(
        'POOL_MAX must be a positive integer',
      );
    }
    expect(() => postgresIdleInTransactionSessionOptions(NaN)).toThrow(
      'must be a positive integer',
    );
  });

  it('does not log query payloads, messages, stack traces or untrusted error codes', () => {
    const logger = { error: vi.fn() };
    const handler = createPostgresConnectionErrorHandler(logger, 'checkpoint');
    handler(
      Object.assign(new Error('password=secret SELECT private'), {
        code: '57P01',
        severity: 'FATAL',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'PostgreSQL checkpoint pool connection error (code=57P01, severity=FATAL)',
    );
    handler(
      Object.assign(new Error('token=private'), { code: 'secret code', severity: 'bad\nline' }),
    );
    expect(logger.error).toHaveBeenLastCalledWith(
      'PostgreSQL checkpoint pool connection error (code=unknown, severity=unknown)',
    );
  });

  it('registers once and follows repeated acquire/release without leaked listeners', () => {
    const pool = new EventEmitter();
    const client = new EventEmitter();
    const logger = { error: vi.fn() };
    const dispose = registerPostgresPoolErrorHandler(pool, logger);
    expect(registerPostgresPoolErrorHandler(pool, logger)).toBe(dispose);
    expect(pool.listenerCount('error')).toBe(1);
    pool.emit('acquire', client);
    pool.emit('acquire', client);
    expect(client.listenerCount('error')).toBe(1);
    client.emit('error', Object.assign(new Error('closed'), { code: '57P01' }));
    expect(logger.error).toHaveBeenCalledWith(
      'PostgreSQL checked-out connection error (code=57P01, severity=unknown)',
    );
    pool.emit('release', undefined, client);
    expect(client.listenerCount('error')).toBe(0);
    pool.emit('acquire', client);
    dispose();
    dispose();
    expect(client.listenerCount('error')).toBe(0);
    expect(pool.listenerCount('error')).toBe(0);
    expect(pool.listenerCount('acquire')).toBe(0);
    expect(pool.listenerCount('release')).toBe(0);
  });
});
