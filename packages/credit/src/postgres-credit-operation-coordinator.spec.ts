import { PGlite } from '@electric-sql/pglite';
import {
  CreditOperationConflictError,
  CreditOperationValidationError,
  PostgresCreditOperationCoordinator,
  type CreditSqlClient,
} from './postgres-credit-operation-coordinator';
import { postgresCreditOperationSchemaSql } from './postgres-credit-operation-test-schema';

const operation = {
  idempotencyKey: 'compensation:task-1',
  accountId: 'user-1',
  operationType: 'GRANT_REFUND',
  amount: 1,
  resourceType: 'durable-task',
  resourceId: 'task-1',
};

describe('PostgresCreditOperationCoordinator', () => {
  let database: PGlite;
  let coordinator: PostgresCreditOperationCoordinator;

  beforeEach(async () => {
    database = await PGlite.create();
    await database.exec(postgresCreditOperationSchemaSql);
    coordinator = new PostgresCreditOperationCoordinator();
  });

  afterEach(async () => {
    await database.close();
  });

  const inTransaction = <T>(work: (client: CreditSqlClient) => Promise<T>) =>
    database.transaction((transaction) =>
      work({
        async query<TRow>(sql: string, parameters?: readonly unknown[]) {
          const result = await transaction.query(sql, parameters ? [...parameters] : []);
          return { rows: result.rows as TRow[] };
        },
      }),
    );

  it('claims an operation once and returns the original receipt on replay', async () => {
    const first = await inTransaction((client) => coordinator.prepare(client, operation));
    const replay = await inTransaction((client) => coordinator.prepare(client, operation));

    expect(first.claimed).toBe(true);
    expect(replay).toMatchObject({ claimed: false, receipt: operation });
    await expect(database.query('SELECT * FROM credit_operation_receipts')).resolves.toHaveProperty(
      'rows.length',
      1,
    );
  });

  it('rejects reuse of an idempotency key with different financial parameters', async () => {
    await inTransaction((client) => coordinator.prepare(client, operation));

    await expect(
      inTransaction((client) => coordinator.prepare(client, { ...operation, amount: 2 })),
    ).rejects.toBeInstanceOf(CreditOperationConflictError);
  });

  it('rolls the receipt back with the caller business transaction', async () => {
    await expect(
      inTransaction(async (client) => {
        await coordinator.prepare(client, operation);
        throw new Error('business write failed');
      }),
    ).rejects.toThrow('business write failed');

    await expect(
      inTransaction((client) => coordinator.prepare(client, operation)),
    ).resolves.toMatchObject({ claimed: true });
  });

  it('validates identifiers and amount before touching the database', async () => {
    await expect(
      inTransaction((client) => coordinator.prepare(client, { ...operation, amount: 0 })),
    ).rejects.toBeInstanceOf(CreditOperationValidationError);
    await expect(
      inTransaction((client) => coordinator.prepare(client, { ...operation, accountId: ' ' })),
    ).rejects.toBeInstanceOf(CreditOperationValidationError);
  });
});
