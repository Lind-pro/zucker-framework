import { PGlite } from '@electric-sql/pglite';
import { PostgresTaskRepository, type PostgresTaskClient } from './postgres-task-repository';
import { PostgresTaskSummaryReader } from './postgres-task-summary-reader';
import { postgresTaskTestSchemaSql } from './postgres-test-schema';

const at = (seconds: number) =>
  new Date(`2026-08-15T00:00:${String(seconds).padStart(2, '0')}.000Z`);

describe('PostgresTaskSummaryReader', () => {
  let database: PGlite;
  let client: PostgresTaskClient;
  let repository: PostgresTaskRepository<{ prompt: string }, { document: string }>;
  let reader: PostgresTaskSummaryReader;

  beforeEach(async () => {
    database = await PGlite.create();
    await database.exec(postgresTaskTestSchemaSql);
    client = {
      async query<TRow>(sql: string, parameters?: readonly unknown[]) {
        const result = await database.query(sql, parameters ? [...parameters] : []);
        return { rows: result.rows as TRow[] };
      },
    };
    repository = new PostgresTaskRepository(client);
    reader = new PostgresTaskSummaryReader(client);
  });

  afterEach(async () => {
    await database.close();
  });

  async function create(id: string, userId: string, now: Date) {
    return repository.create({
      id,
      kind: 'PATENT_GENERATION',
      resource: { type: 'patent', id: `patent-${id}` },
      userId,
      idempotencyKey: `key-${id}`,
      idempotencyFingerprint: `fingerprint-${id}`,
      handlerVersion: 'v1',
      payload: { prompt: `secret-${id}` },
      maxAttempts: 3,
      now,
    });
  }

  it('lists only the requested owner and returns no execution secrets', async () => {
    await create('task-1', 'user-1', at(1));
    await create('task-2', 'user-2', at(2));

    const summaries = await reader.listOwned({ userId: 'user-1' });

    expect(summaries).toEqual([
      expect.objectContaining({
        id: 'task-1',
        resource: { type: 'patent', id: 'patent-task-1' },
        status: 'QUEUED',
      }),
    ]);
    expect(JSON.stringify(summaries)).not.toContain('secret-task-1');
    expect(summaries[0]).not.toHaveProperty('payload');
    expect(summaries[0]).not.toHaveProperty('result');
    expect(summaries[0]).not.toHaveProperty('error.metadata');
    expect(summaries[0]).not.toHaveProperty('providerRequestId');
  });

  it('filters statuses, orders newest first and caps the requested limit', async () => {
    await create('task-1', 'user-1', at(1));
    await create('task-2', 'user-1', at(2));
    await repository.claim({
      id: 'task-2',
      workerId: 'worker-1',
      leaseToken: 'lease-1',
      leaseExpiresAt: at(20),
      now: at(3),
    });

    await expect(
      reader.listOwned({
        userId: 'user-1',
        statuses: ['PROCESSING'],
        limit: 1_000,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 'task-2', status: 'PROCESSING' })]);
  });

  it('does not reveal whether another owner task exists', async () => {
    await create('task-1', 'user-1', at(1));

    await expect(reader.findOwnedById('task-1', 'user-2')).resolves.toBeNull();
    await expect(reader.findOwnedById('task-1', 'user-1')).resolves.toMatchObject({
      id: 'task-1',
      kind: 'PATENT_GENERATION',
    });
  });
});
