import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { PostgresTaskRepository, type PostgresTaskClient } from './postgres-task-repository';
import { postgresTaskTestSchemaSql } from './postgres-test-schema';
import { TaskLeaseReconciler } from './task-lease-reconciler';

type WorkerMessage = {
  type: 'claimed' | 'claim-failed' | 'completed' | 'complete-failed' | 'error';
  attempt?: number;
  message?: string;
};

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const workerFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../test-fixtures/task-worker.mjs',
);

function taskClient(client: Client): PostgresTaskClient {
  return {
    async query<TRow>(sql: string, parameters?: readonly unknown[]) {
      const result = await client.query(sql, parameters ? [...parameters] : []);
      return { rows: result.rows as TRow[] };
    },
  };
}

function startWorker(options: {
  schemaName: string;
  taskId: string;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  mode: 'hang' | 'await-complete';
}): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      workerFixture,
      databaseUrl as string,
      options.schemaName,
      options.taskId,
      options.workerId,
      options.leaseToken,
      options.leaseExpiresAt.toISOString(),
      options.mode,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

function waitForMessage(
  child: ChildProcessWithoutNullStreams,
  expectedType: WorkerMessage['type'],
): Promise<WorkerMessage> {
  return new Promise((resolveMessage, rejectMessage) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      rejectMessage(new Error(`Worker did not emit ${expectedType}. stderr: ${stderr}`));
    }, 10_000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const message = JSON.parse(line) as WorkerMessage;
        if (message.type === 'error') {
          cleanup();
          rejectMessage(new Error(message.message));
          return;
        }
        if (message.type === expectedType) {
          cleanup();
          resolveMessage(message);
          return;
        }
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectMessage(
        new Error(
          `Worker exited before ${expectedType} (code=${String(code)}, signal=${String(signal)}). stderr: ${stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once('exit', () => resolveExit()));
}

describeWithPostgres('durable task worker restart', () => {
  it('recovers a killed worker and fences its stale lease', async () => {
    const schemaName = `zucker_restart_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const client = new Client({ connectionString: databaseUrl });
    let firstWorker: ChildProcessWithoutNullStreams | undefined;
    let secondWorker: ChildProcessWithoutNullStreams | undefined;
    await client.connect();

    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query(`SET search_path TO "${schemaName}"`);
      await client.query(postgresTaskTestSchemaSql);
      const repository = new PostgresTaskRepository<{ drawingId: string }, { completedBy: string }>(
        taskClient(client),
      );
      const now = new Date();
      await repository.create({
        id: 'task-restart-1',
        kind: 'DRAWING_GENERATION',
        resource: { type: 'drawing', id: 'drawing-1' },
        idempotencyKey: 'drawing-1-restart-v1',
        idempotencyFingerprint: 'sha256:restart-test',
        handlerVersion: 'v1',
        payload: { drawingId: 'drawing-1' },
        maxAttempts: 3,
        now,
      });

      const firstLeaseToken = 'lease-killed-worker';
      firstWorker = startWorker({
        schemaName,
        taskId: 'task-restart-1',
        workerId: 'worker-killed',
        leaseToken: firstLeaseToken,
        leaseExpiresAt: new Date(Date.now() + 500),
        mode: 'hang',
      });
      await expect(waitForMessage(firstWorker, 'claimed')).resolves.toMatchObject({ attempt: 1 });
      firstWorker.kill('SIGKILL');
      await waitForExit(firstWorker);

      await new Promise((resolveWait) => setTimeout(resolveWait, 600));
      const reconciler = new TaskLeaseReconciler(repository);
      await expect(reconciler.runOnce()).resolves.toMatchObject({ found: 1, requeued: 1 });

      const secondLeaseToken = 'lease-replacement-worker';
      secondWorker = startWorker({
        schemaName,
        taskId: 'task-restart-1',
        workerId: 'worker-replacement',
        leaseToken: secondLeaseToken,
        leaseExpiresAt: new Date(Date.now() + 5_000),
        mode: 'await-complete',
      });
      await expect(waitForMessage(secondWorker, 'claimed')).resolves.toMatchObject({ attempt: 2 });

      await expect(
        repository.transition({
          id: 'task-restart-1',
          from: 'PROCESSING',
          to: 'COMPLETED',
          leaseToken: firstLeaseToken,
          result: { completedBy: 'worker-killed' },
          now: new Date(),
        }),
      ).resolves.toBeNull();

      const completedMessage = waitForMessage(secondWorker, 'completed');
      secondWorker.stdin.end('complete\n');
      await expect(completedMessage).resolves.toMatchObject({ type: 'completed' });
      await waitForExit(secondWorker);

      await expect(repository.findById('task-restart-1')).resolves.toMatchObject({
        status: 'COMPLETED',
        attempt: 2,
        result: { completedBy: 'worker-replacement' },
      });
    } finally {
      if (firstWorker && firstWorker.exitCode === null && firstWorker.signalCode === null) {
        firstWorker.kill('SIGKILL');
      }
      if (secondWorker && secondWorker.exitCode === null && secondWorker.signalCode === null) {
        secondWorker.kill('SIGKILL');
      }
      await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await client.end();
    }
  }, 30_000);
});
