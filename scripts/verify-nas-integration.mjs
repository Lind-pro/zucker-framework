import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliRequire = createRequire(join(rootDir, 'packages/cli/package.json'));
const queueRequire = createRequire(join(rootDir, 'packages/queue/package.json'));
const { Client } = cliRequire('pg');
const { parse } = cliRequire('dotenv');
const Redis = queueRequire('ioredis');
const args = process.argv.slice(2);
const envIndex = args.indexOf('--env-file');
if (envIndex >= 0 && !args[envIndex + 1]) throw new Error('--env-file requires a private configuration file');
const configuration = envIndex >= 0 ? parse(readFileSync(resolve(args[envIndex + 1]))) : process.env;
const databaseValue = configuration.NAS_TEST_ADMIN_DATABASE_URL ?? configuration.DATABASE_URL;
const redisValue = configuration.NAS_TEST_REDIS_URL ?? configuration.REDIS_URL;
if (!databaseValue || !redisValue) throw new Error('Provide explicit NAS PostgreSQL and Redis URLs; this command never creates replacement services');
const adminUrl = new URL(databaseValue);
const redisUrl = new URL(redisValue);
if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol) || !['redis:', 'rediss:'].includes(redisUrl.protocol)) {
  throw new Error('Unsupported PostgreSQL or Redis URL scheme');
}
adminUrl.pathname = '/postgres';
const runId = `${Date.now()}_${randomBytes(4).toString('hex')}`;
const databaseName = `zucker_release_${runId}`;
const redisPrefix = `zucker-release-${runId}`;
if (!/^zucker_release_\d+_[a-f0-9]{8}$/.test(databaseName)) throw new Error('Invalid generated test database name');
const testUrl = new URL(adminUrl); testUrl.pathname = `/${databaseName}`;
const secrets = [databaseValue, redisValue, adminUrl.href, testUrl.href,
  adminUrl.password, redisUrl.password, decodeURIComponent(adminUrl.password), decodeURIComponent(redisUrl.password)].filter(Boolean);
const redact = (value) => secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value));
const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000, query_timeout: 10000 });
const redis = new Redis(redisUrl.href, { lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: 1, retryStrategy: () => null });
redis.on('error', () => {});
let created = false;
let testOutput = '';
const report = { environment: 'user-designated NAS', database: databaseName, redisPrefix, testsPassed: false,
  databaseRemoved: false, redisKeysRemaining: null };
const outputDir = join(rootDir, 'artifacts'); mkdirSync(outputDir, { recursive: true });
const writeReport = () => writeFileSync(join(outputDir, 'nas-integration-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
// Preserve the generated resource names even if the process is interrupted before finally runs.
writeReport();
writeFileSync(join(outputDir, 'nas-integration-verification.log'), '');
try {
  await admin.connect();
  await redis.connect();
  await redis.ping();
  report.postgresVersion = (await admin.query("SELECT current_setting('server_version') AS version")).rows[0].version;
  report.redisVersion = (await redis.info('server')).match(/^redis_version:(.+)$/m)?.[1].trim();
  await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  created = true;
  process.stdout.write('Created a temporary database on the configured NAS; testing with an isolated Redis prefix.\n');
  const environment = { ...process.env, TEST_DATABASE_URL: testUrl.href, AI_ACCESS_POSTGRES_TEST_URL: testUrl.href,
    TEST_REDIS_URL: redisUrl.href, TEST_REDIS_PREFIX: redisPrefix };
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      'packages/task/src/postgres-task-repository.integration.spec.ts', 'packages/task/src/worker-restart.integration.spec.ts',
      'packages/queue/src/bullmq.integration.spec.ts', 'packages/ai-access/src/postgres-profile-store.integration.spec.ts', '--reporter=dot'],
    { cwd: rootDir, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { testOutput += chunk; });
    child.stderr.on('data', (chunk) => { testOutput += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 90000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code); });
  });
  report.testsPassed = exitCode === 0;
  if (!report.testsPassed) throw new Error(`NAS integration tests failed (${exitCode})`);
  const crudExitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ['scripts/verify-crud-postgres-contract.mjs'],
      { cwd: rootDir, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { testOutput += chunk; });
    child.stderr.on('data', chunk => { testOutput += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolveExit(code); });
  });
  report.crudPostgresPassed = crudExitCode === 0;
  report.testsPassed = report.testsPassed && report.crudPostgresPassed;
  if (!report.crudPostgresPassed) throw new Error(`CRUD PostgreSQL contract failed (${crudExitCode})`);
} catch (error) {
  report.error = redact(error.message);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      report.databaseRemoved = true;
    } catch (error) { report.databaseCleanupError = redact(error.message); process.exitCode = 1; }
  }
  if (redis.status === 'ready') {
    try {
      let cursor = '0';
      do {
        const result = await redis.scan(cursor, 'MATCH', `${redisPrefix}:*`, 'COUNT', 100);
        cursor = result[0];
        // This per-run prefix is generated above. Never flush the DB or unlink unrelated keys.
        if (result[1].length) await redis.unlink(...result[1]);
      } while (cursor !== '0');
      let remaining = 0;
      do { const result = await redis.scan(cursor, 'MATCH', `${redisPrefix}:*`, 'COUNT', 100); cursor = result[0]; remaining += result[1].length; } while (cursor !== '0');
      report.redisKeysRemaining = remaining;
      if (remaining) process.exitCode = 1;
    } catch (error) { report.redisCleanupError = redact(error.message); process.exitCode = 1; }
  }
  await admin.end().catch(() => {});
  redis.disconnect();
  writeFileSync(join(outputDir, 'nas-integration-verification.log'), redact(testOutput));
  writeReport();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.testsPassed) process.stderr.write(redact(testOutput).slice(-5000));
}
