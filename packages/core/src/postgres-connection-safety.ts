import type { EventEmitter } from 'node:events';

export type PostgresConnectionSource = 'pool' | 'checked-out connection';
export interface PostgresErrorLogger {
  error(message: string): void;
}

/** Explicit configuration input; the application owns environment names/defaults. */
export function readPositiveIntegerConfiguration(
  name: string,
  fallback: number,
  configured: string | undefined,
): number {
  if (configured === undefined) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Startup options protect every physical connection, including pooled ones. */
export function postgresIdleInTransactionSessionOptions(timeoutMs: number): string {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('idleInTransactionSessionTimeoutMs must be a positive integer');
  }
  return `-c timezone=UTC -c idle_in_transaction_session_timeout=${timeoutMs}`;
}

function sanitizeErrorField(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : 'unknown';
}

/** Logs only error codes/severity; server messages can contain SQL or secrets. */
export function createPostgresConnectionErrorHandler(
  logger: PostgresErrorLogger,
  context?: string,
  source: PostgresConnectionSource = 'pool',
): (error: Error) => void {
  return (error) => {
    const pgError = error as Error & { code?: unknown; severity?: unknown };
    const label = context ? ` ${context}` : '';
    const sourceLabel = source === 'pool' ? 'pool connection' : source;
    logger.error(
      `PostgreSQL${label} ${sourceLabel} error (code=${sanitizeErrorField(pgError.code)}, severity=${sanitizeErrorField(pgError.severity)})`,
    );
  };
}

type ConnectionEvents = Pick<EventEmitter, 'on' | 'off'>;
const registrations = new WeakMap<ConnectionEvents, () => void>();

/**
 * Handles idle-pool and checked-out connection errors without creating a pool or
 * retrying failed queries. Register once for the pool's lifetime. The returned
 * cleanup is idempotent and should only run after the pool is shut down.
 */
export function registerPostgresPoolErrorHandler(
  pool: ConnectionEvents,
  logger: PostgresErrorLogger,
  context?: string,
): () => void {
  const existing = registrations.get(pool);
  if (existing) return existing;
  const checkedOut = new Map<ConnectionEvents, (error: Error) => void>();
  const onPoolError = createPostgresConnectionErrorHandler(logger, context);
  const onAcquire = (client: ConnectionEvents) => {
    if (checkedOut.has(client)) return;
    const handler = createPostgresConnectionErrorHandler(logger, context, 'checked-out connection');
    checkedOut.set(client, handler);
    client.on('error', handler);
  };
  const onRelease = (_error: unknown, client: ConnectionEvents) => {
    const handler = checkedOut.get(client);
    if (!handler) return;
    client.off('error', handler);
    checkedOut.delete(client);
  };
  pool.on('error', onPoolError);
  pool.on('acquire', onAcquire);
  pool.on('release', onRelease);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pool.off('error', onPoolError);
    pool.off('acquire', onAcquire);
    pool.off('release', onRelease);
    for (const [client, handler] of checkedOut) client.off('error', handler);
    checkedOut.clear();
    registrations.delete(pool);
  };
  registrations.set(pool, dispose);
  return dispose;
}
