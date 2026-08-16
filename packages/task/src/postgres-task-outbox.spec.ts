import { PGlite } from '@electric-sql/pglite';
import { PostgresTaskOutboxRepository } from './postgres-task-outbox';
import type { PostgresTaskClient } from './postgres-task-repository';
import { TaskOutboxConflictError } from './task-outbox';

const at = (seconds: number) =>
  new Date(`2026-08-15T00:00:${String(seconds).padStart(2, '0')}.000Z`);

const schema = `
  CREATE TYPE async_job_outbox_status AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED');

  CREATE TABLE async_jobs (
    "id" text PRIMARY KEY
  );

  CREATE TABLE async_job_outbox (
    "id" text PRIMARY KEY,
    "taskId" text NOT NULL REFERENCES async_jobs("id") ON DELETE CASCADE,
    "topic" text NOT NULL,
    "payload" jsonb NOT NULL,
    "status" async_job_outbox_status NOT NULL DEFAULT 'PENDING',
    "attempt" integer NOT NULL DEFAULT 0,
    "availableAt" timestamptz NOT NULL,
    "workerId" text,
    "leaseToken" text,
    "leaseExpiresAt" timestamptz,
    "publishedAt" timestamptz,
    "lastError" text,
    "createdAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL
  );

  INSERT INTO async_jobs ("id") VALUES ('task-1');
`;

describe('PostgresTaskOutboxRepository', () => {
  let database: PGlite;
  let outbox: PostgresTaskOutboxRepository<{ taskId: string }>;

  beforeEach(async () => {
    database = await PGlite.create();
    await database.exec(schema);
    const client: PostgresTaskClient = {
      async query<TRow>(sql: string, parameters?: readonly unknown[]) {
        const result = await database.query(sql, parameters ? [...parameters] : []);
        return { rows: result.rows as TRow[] };
      },
    };
    outbox = new PostgresTaskOutboxRepository(client);
  });

  afterEach(async () => {
    await database.close();
  });

  const append = async () =>
    outbox.append({
      id: 'event-1',
      taskId: 'task-1',
      topic: 'task.created',
      payload: { taskId: 'task-1' },
      now: at(0),
    });

  it('appends idempotently and preserves the event payload', async () => {
    await expect(append()).resolves.toMatchObject({
      created: true,
      record: { payload: { taskId: 'task-1' } },
    });
    await expect(append()).resolves.toMatchObject({ created: false });
  });

  it('rejects reuse of an event id with different content', async () => {
    await append();

    await expect(
      outbox.append({
        id: 'event-1',
        taskId: 'task-1',
        topic: 'task.created',
        payload: { taskId: 'task-changed' },
        now: at(1),
      }),
    ).rejects.toBeInstanceOf(TaskOutboxConflictError);
  });

  it('reloads an event when a concurrent conflict is outside the insert snapshot', async () => {
    let hideInsertResult = true;
    const snapshotClient: PostgresTaskClient = {
      async query<TRow>(sql: string, parameters?: readonly unknown[]) {
        const result = await database.query(sql, parameters ? [...parameters] : []);
        if (hideInsertResult && sql.includes('WITH inserted AS')) {
          hideInsertResult = false;
          return { rows: [] };
        }
        return { rows: result.rows as TRow[] };
      },
    };
    const snapshotOutbox = new PostgresTaskOutboxRepository<{ taskId: string }>(snapshotClient);

    await expect(
      snapshotOutbox.append({
        id: 'event-1',
        taskId: 'task-1',
        topic: 'task.created',
        payload: { taskId: 'task-1' },
        now: at(0),
      }),
    ).resolves.toMatchObject({ created: false, record: { id: 'event-1' } });
  });

  it('allows only one concurrent dispatcher to claim an event', async () => {
    await append();
    const [first, second] = await Promise.all([
      outbox.claimBatch({
        workerId: 'dispatcher-a',
        leaseToken: 'lease-a',
        leaseExpiresAt: at(20),
        limit: 10,
        now: at(1),
      }),
      outbox.claimBatch({
        workerId: 'dispatcher-b',
        leaseToken: 'lease-b',
        leaseExpiresAt: at(20),
        limit: 10,
        now: at(1),
      }),
    ]);

    expect(first.length + second.length).toBe(1);
    expect([...first, ...second][0]).toMatchObject({ status: 'PUBLISHING', attempt: 1 });
  });

  it('reclaims at the lease expiry boundary and fences the stale dispatcher', async () => {
    await append();
    await outbox.claimBatch({
      workerId: 'dispatcher-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(10),
      limit: 1,
      now: at(1),
    });

    const reclaimed = await outbox.claimBatch({
      workerId: 'dispatcher-b',
      leaseToken: 'lease-b',
      leaseExpiresAt: at(30),
      limit: 1,
      now: at(10),
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ leaseToken: 'lease-b', attempt: 2 });
    await expect(outbox.markPublished('event-1', 'lease-a', at(11))).resolves.toBe(false);
    await expect(outbox.markPublished('event-1', 'lease-b', at(11))).resolves.toBe(true);
  });

  it('rejects stale rescheduling and makes a valid retry available later', async () => {
    await append();
    await outbox.claimBatch({
      workerId: 'dispatcher-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: at(10),
      limit: 1,
      now: at(1),
    });
    await expect(
      outbox.reschedule('event-1', 'lease-a', at(20), 'redis unavailable', at(10)),
    ).resolves.toBe(false);

    const reclaimed = await outbox.claimBatch({
      workerId: 'dispatcher-b',
      leaseToken: 'lease-b',
      leaseExpiresAt: at(30),
      limit: 1,
      now: at(10),
    });
    expect(reclaimed).toHaveLength(1);
    await expect(
      outbox.reschedule('event-1', 'lease-b', at(20), 'redis unavailable', at(11)),
    ).resolves.toBe(true);
    await expect(
      outbox.claimBatch({
        workerId: 'dispatcher-c',
        leaseToken: 'lease-c',
        leaseExpiresAt: at(30),
        limit: 1,
        now: at(19),
      }),
    ).resolves.toHaveLength(0);
    await expect(
      outbox.claimBatch({
        workerId: 'dispatcher-c',
        leaseToken: 'lease-c',
        leaseExpiresAt: at(40),
        limit: 1,
        now: at(20),
      }),
    ).resolves.toHaveLength(1);
  });
});
