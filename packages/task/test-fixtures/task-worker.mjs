import { Client } from 'pg';
import { PostgresTaskRepository } from '../dist/index.mjs';

const [databaseUrl, schemaName, taskId, workerId, leaseToken, leaseExpiresAt, mode] =
  process.argv.slice(2);

const client = new Client({ connectionString: databaseUrl });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

try {
  await client.connect();
  await client.query(`SET search_path TO "${schemaName}"`);
  const repository = new PostgresTaskRepository({
    async query(sql, parameters) {
      const result = await client.query(sql, parameters ? [...parameters] : []);
      return { rows: result.rows };
    },
  });
  const claimed = await repository.claim({
    id: taskId,
    workerId,
    leaseToken,
    leaseExpiresAt: new Date(leaseExpiresAt),
    now: new Date(),
  });
  if (!claimed) {
    send({ type: 'claim-failed' });
    process.exitCode = 2;
  } else {
    send({ type: 'claimed', attempt: claimed.attempt });
    if (mode === 'hang') {
      await new Promise(() => undefined);
    } else {
      await new Promise((resolve) => process.stdin.once('data', resolve));
      const completed = await repository.transition({
        id: taskId,
        from: 'PROCESSING',
        to: 'COMPLETED',
        leaseToken,
        result: { completedBy: workerId },
        now: new Date(),
      });
      send({ type: completed ? 'completed' : 'complete-failed' });
      if (!completed) process.exitCode = 3;
    }
  }
} catch (error) {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
