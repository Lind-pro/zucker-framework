import { PGlite } from '@electric-sql/pglite';
import { PostgresTaskRepository, type PostgresTaskClient } from './postgres-task-repository';
import { postgresTaskTestSchemaSql } from './postgres-test-schema';
import { PostgresTaskRedriver } from './task-redriver';
import { PostgresTaskTimelineReader } from './task-timeline';

const at = (seconds: number) =>
  new Date(`2026-08-16T00:00:${String(seconds).padStart(2, '0')}.000Z`);

describe('task timeline and redrive', () => {
  let database: PGlite;
  let client: PostgresTaskClient;
  let tasks: PostgresTaskRepository<{ patentId: string }>;
  let timeline: PostgresTaskTimelineReader;
  let redriver: PostgresTaskRedriver;

  beforeEach(async () => {
    database = await PGlite.create();
    await database.exec(postgresTaskTestSchemaSql);
    client = {
      async query<TRow>(sql: string, parameters?: readonly unknown[]) {
        const result = await database.query(sql, parameters ? [...parameters] : []);
        return { rows: result.rows as TRow[] };
      },
    };
    tasks = new PostgresTaskRepository(client);
    timeline = new PostgresTaskTimelineReader(client);
    redriver = new PostgresTaskRedriver(client);
  });

  afterEach(async () => {
    await database.close();
  });

  async function createAndFail() {
    await tasks.create({
      id: 'task-1',
      kind: 'PATENT_GENERATION',
      resource: { type: 'patent', id: 'patent-1' },
      userId: 'user-1',
      idempotencyKey: 'patent-1:generate',
      idempotencyFingerprint: 'sha256:input',
      handlerVersion: 'v1',
      payload: { patentId: 'patent-1' },
      maxAttempts: 2,
      now: at(0),
    });
    await tasks.claim({
      id: 'task-1',
      workerId: 'worker-1',
      leaseToken: 'lease-1',
      leaseExpiresAt: at(20),
      now: at(1),
    });
    await tasks.reportProgress({
      id: 'task-1',
      leaseToken: 'lease-1',
      stage: 'claims',
      progress: 40,
      now: at(2),
    });
    await tasks.transition({
      id: 'task-1',
      from: 'PROCESSING',
      to: 'FAILED',
      leaseToken: 'lease-1',
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        category: 'PROVIDER_TRANSIENT',
        summary: 'PROVIDER_UNAVAILABLE',
        retryable: true,
        metadata: { confidential: 'not-for-timeline' },
      },
      providerRequestId: 'provider-request-1',
      now: at(3),
    });
  }

  it('records a payload-free ordered timeline and keeps worker details admin-only', async () => {
    await createAndFail();

    await expect(timeline.listOwned('task-1', 'user-1')).resolves.toEqual([
      expect.objectContaining({ sequence: 0, type: 'CREATED', toStatus: 'QUEUED' }),
      expect.objectContaining({ sequence: 1, type: 'CLAIMED', attempt: 1 }),
      expect.objectContaining({ sequence: 2, type: 'PROGRESS', stage: 'claims', progress: 40 }),
      expect.objectContaining({
        sequence: 3,
        type: 'FAILED',
        error: expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
      }),
    ]);
    const owned = await timeline.listOwned('task-1', 'user-1');
    expect(owned[1]).not.toHaveProperty('workerId');
    expect(JSON.stringify(owned)).not.toContain('confidential');
    await expect(timeline.listOwned('task-1', 'user-2')).resolves.toEqual([]);
    await expect(timeline.listByTaskId('task-1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workerId: 'worker-1' }),
        expect.objectContaining({ providerRequestId: 'provider-request-1' }),
      ]),
    );
  });

  it('redrives only failed work, preserves attempt history, and emits a redrive event', async () => {
    await createAndFail();

    await expect(redriver.redriveFailed({ taskId: 'task-1', now: at(4) })).resolves.toMatchObject({
      taskId: 'task-1',
      attempt: 1,
      maxAttempts: 2,
      availableAt: at(4),
    });
    await expect(tasks.findById('task-1')).resolves.toMatchObject({
      status: 'QUEUED',
      stage: 'manual-redrive',
      error: undefined,
      completedAt: undefined,
    });
    await expect(timeline.listByTaskId('task-1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'MANUAL_REDRIVE', fromStatus: 'FAILED' }),
      ]),
    );
    await expect(redriver.redriveFailed({ taskId: 'task-1', now: at(5) })).resolves.toBeNull();
  });

  it('extends an exhausted attempt budget by the requested bounded amount', async () => {
    await createAndFail();
    await database.query(
      `UPDATE async_jobs SET "attempt" = 2, "maxAttempts" = 2 WHERE "id" = 'task-1'`,
    );

    await expect(
      redriver.redriveFailed({ taskId: 'task-1', additionalAttempts: 2, now: at(4) }),
    ).resolves.toMatchObject({ attempt: 2, maxAttempts: 4 });
    await expect(
      redriver.redriveFailed({ taskId: 'missing', additionalAttempts: 0, now: at(5) }),
    ).rejects.toThrow(RangeError);
  });
});
