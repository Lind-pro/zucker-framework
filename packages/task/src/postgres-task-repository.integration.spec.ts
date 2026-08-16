import { Client } from 'pg';
import { PostgresTaskRepository, type PostgresTaskClient } from './postgres-task-repository';
import { postgresTaskTestSchemaSql } from './postgres-test-schema';
import type { CreateTaskInput } from './task-repository';

type Payload = { drawingId: string };

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const at = (seconds: number) =>
  new Date(`2026-08-15T00:00:${String(seconds).padStart(2, '0')}.000Z`);

function taskClient(client: Client): PostgresTaskClient {
  return {
    async query<TRow>(sql: string, parameters?: readonly unknown[]) {
      const result = await client.query(sql, parameters ? [...parameters] : []);
      return { rows: result.rows as TRow[] };
    },
  };
}

const createInput = (id: string): CreateTaskInput<Payload> => ({
  id,
  kind: 'DRAWING_GENERATION',
  resource: { type: 'drawing', id: 'drawing-1' },
  idempotencyKey: 'drawing-1-generate-v1',
  idempotencyFingerprint: 'sha256:drawing-request',
  handlerVersion: 'v1',
  payload: { drawingId: 'drawing-1' },
  maxAttempts: 3,
  now: at(0),
});

describeWithPostgres('PostgresTaskRepository multi-connection integration', () => {
  it('deduplicates concurrent creation and grants only one attempt lease', async () => {
    const schemaName = `zucker_task_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const firstClient = new Client({ connectionString: databaseUrl });
    const secondClient = new Client({ connectionString: databaseUrl });
    await Promise.all([firstClient.connect(), secondClient.connect()]);

    try {
      await firstClient.query(`CREATE SCHEMA "${schemaName}"`);
      await Promise.all([
        firstClient.query(`SET search_path TO "${schemaName}"`),
        secondClient.query(`SET search_path TO "${schemaName}"`),
      ]);
      await firstClient.query(postgresTaskTestSchemaSql);
      const firstRepository = new PostgresTaskRepository<Payload>(taskClient(firstClient));
      const secondRepository = new PostgresTaskRepository<Payload>(taskClient(secondClient));

      const created = await Promise.all([
        firstRepository.create(createInput('task-1')),
        secondRepository.create(createInput('task-2')),
      ]);
      expect(created.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(created.map((result) => result.task.id))).toHaveProperty('size', 1);

      const taskId = created[0].task.id;
      const claimed = await Promise.all([
        firstRepository.claim({
          id: taskId,
          workerId: 'worker-a',
          leaseToken: 'lease-a',
          leaseExpiresAt: at(20),
          now: at(1),
        }),
        secondRepository.claim({
          id: taskId,
          workerId: 'worker-b',
          leaseToken: 'lease-b',
          leaseExpiresAt: at(20),
          now: at(1),
        }),
      ]);
      expect(claimed.filter(Boolean)).toHaveLength(1);
    } finally {
      await firstClient.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
  }, 20_000);

  it('preserves task state when a repository connection is terminated', async () => {
    const schemaName = `zucker_db_outage_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const repositoryClient = new Client({ connectionString: databaseUrl });
    const adminClient = new Client({ connectionString: databaseUrl });
    const recoveryClient = new Client({ connectionString: databaseUrl });
    repositoryClient.on('error', () => undefined);
    await Promise.all([
      repositoryClient.connect(),
      adminClient.connect(),
      recoveryClient.connect(),
    ]);

    try {
      await repositoryClient.query(`CREATE SCHEMA "${schemaName}"`);
      await Promise.all([
        repositoryClient.query(`SET search_path TO "${schemaName}"`),
        recoveryClient.query(`SET search_path TO "${schemaName}"`),
      ]);
      await repositoryClient.query(postgresTaskTestSchemaSql);
      const repository = new PostgresTaskRepository<Payload>(taskClient(repositoryClient));
      await repository.create({
        ...createInput('task-outage'),
        idempotencyKey: 'drawing-1-outage-v1',
      });
      const backend = await repositoryClient.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );

      await adminClient.query('SELECT pg_terminate_backend($1)', [backend.rows[0].pid]);
      await expect(repository.findById('task-outage')).rejects.toThrow();

      const recoveredRepository = new PostgresTaskRepository<Payload>(taskClient(recoveryClient));
      await expect(recoveredRepository.findById('task-outage')).resolves.toMatchObject({
        status: 'QUEUED',
        attempt: 0,
      });
    } finally {
      await adminClient.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await Promise.all([
        repositoryClient.end().catch(() => undefined),
        adminClient.end(),
        recoveryClient.end(),
      ]);
    }
  }, 20_000);
});
