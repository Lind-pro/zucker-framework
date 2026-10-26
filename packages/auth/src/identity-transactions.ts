/** A caller-owned transaction; no connection pool or nested transaction is created here. */
export interface IdentityTransactions<Tx> {
  run<T>(subject: string, work: (tx: Tx) => Promise<T>): Promise<T>;
}

/** Serialize identity operations across processes using the caller's PostgreSQL transaction. */
export class PostgresIdentityTransactions<Tx> implements IdentityTransactions<Tx> {
  constructor(private readonly options: {
    transaction: <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;
    query: (tx: Tx, sql: string, values: readonly unknown[]) => Promise<unknown>;
    namespace: string;
  }) {}

  run<T>(subject: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.options.transaction(async (tx) => {
      await this.options.query(tx, 'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${this.options.namespace}:${subject}`,
      ]);
      return work(tx);
    });
  }
}
