export type PostgresAdvisoryLockResult<T> = { acquired: false } | { acquired: true; value: T };

/** A dedicated session, never a pool query facade whose connection can change. */
export interface PostgresAdvisoryLockConnection {
  on(event: 'error', listener: (error: Error) => void): unknown;
  connect(): Promise<unknown>;
  query(sql: string, values: string[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
}

export interface PostgresAdvisoryLockOptions {
  createConnection: () => PostgresAdvisoryLockConnection;
  logger?: { error(message: string): void; warn(message: string): void };
}

/**
 * Try a session advisory lock and always close the dedicated connection. A busy
 * lock skips work. Task/connect/query errors propagate; unlock/close failures
 * are best-effort and do not replace the task outcome. This is not a lease or
 * fencing primitive: losing the database session releases its lock, and callers
 * remain responsible for side-effect idempotency if their task is still running.
 */
export async function runWithPostgresAdvisoryLock<T>(
  key: string,
  task: () => Promise<T>,
  options: PostgresAdvisoryLockOptions,
): Promise<PostgresAdvisoryLockResult<T>> {
  if (!key) throw new Error('PostgreSQL advisory lock key must not be empty');
  const client = options.createConnection();
  client.on('error', () => {
    options.logger?.error('PostgreSQL advisory lock connection failed');
  });
  let acquired = false;
  try {
    await client.connect();
    const result = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [key],
    );
    acquired = result.rows[0]?.acquired === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, value: await task() };
  } finally {
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      } catch {
        options.logger?.warn('PostgreSQL advisory lock release failed');
      }
    }
    try {
      await client.end();
    } catch {
      options.logger?.warn('PostgreSQL advisory lock connection close failed');
    }
  }
}
