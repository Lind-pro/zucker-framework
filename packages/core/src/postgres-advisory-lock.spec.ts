import { describe, expect, it, vi } from 'vitest';
import { runWithPostgresAdvisoryLock } from './postgres-advisory-lock';

function harness(acquired = true) {
  const connection = {
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    query: vi.fn(async (_sql: string, _values: string[]) => ({ rows: [{ acquired }] })),
    end: vi.fn(async () => undefined),
  };
  const logger = { error: vi.fn(), warn: vi.fn() };
  const options = { createConnection: vi.fn(() => connection), logger };
  return { connection, logger, options };
}

describe('runWithPostgresAdvisoryLock', () => {
  it('uses one dedicated connection for acquire, work and release', async () => {
    const { connection, options } = harness();
    const task = vi.fn(async () => 'done');
    await expect(runWithPostgresAdvisoryLock('scheduled:delivery', task, options)).resolves.toEqual(
      { acquired: true, value: 'done' },
    );
    expect(options.createConnection).toHaveBeenCalledTimes(1);
    expect(connection.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      ['scheduled:delivery'],
    );
    expect(connection.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
      ['scheduled:delivery'],
    );
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  it('skips a busy lock and closes the connection without unlocking it', async () => {
    const { connection, options } = harness(false);
    const task = vi.fn();
    await expect(runWithPostgresAdvisoryLock('busy', task, options)).resolves.toEqual({
      acquired: false,
    });
    expect(task).not.toHaveBeenCalled();
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.end).toHaveBeenCalledTimes(1);
  });

  it('preserves the task error through failed unlock and close', async () => {
    const { connection, options, logger } = harness();
    connection.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(new Error('private unlock details'));
    connection.end.mockRejectedValueOnce(new Error('private close details'));
    const failure = new Error('task failed');
    await expect(
      runWithPostgresAdvisoryLock(
        'failure',
        async () => {
          throw failure;
        },
        options,
      ),
    ).rejects.toBe(failure);
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls).toEqual([
      ['PostgreSQL advisory lock release failed'],
      ['PostgreSQL advisory lock connection close failed'],
    ]);
  });

  it('closes a failed connection and rejects an empty key before allocation', async () => {
    const { connection, options } = harness();
    const failure = new Error('database unavailable');
    connection.connect.mockRejectedValueOnce(failure);
    await expect(
      runWithPostgresAdvisoryLock('connect', async () => undefined, options),
    ).rejects.toBe(failure);
    expect(connection.query).not.toHaveBeenCalled();
    expect(connection.end).toHaveBeenCalledTimes(1);
    options.createConnection.mockClear();
    await expect(runWithPostgresAdvisoryLock('', async () => undefined, options)).rejects.toThrow(
      'must not be empty',
    );
    expect(options.createConnection).not.toHaveBeenCalled();
  });
});
