import { randomUUID } from 'node:crypto';

export const JOBS_OPTIONS = Symbol('JOBS_OPTIONS');
export interface JobsOptions {
  enabled: boolean;
  workerId: string;
  concurrency: number;
  scanIntervalMs: number;
  leaseMs: number;
  heartbeatMs: number;
  shutdownWaitMs: number;
}
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${key}`);
  return value;
}
export function jobsOptionsFromEnvironment(env: NodeJS.ProcessEnv): JobsOptions {
  if (env.JOBS_ENABLED !== undefined && env.JOBS_ENABLED !== 'true' && env.JOBS_ENABLED !== 'false') throw new Error('Invalid JOBS_ENABLED');
  const leaseMs = integer(env, 'JOBS_LEASE_MS', 30_000, 1000, 300_000);
  const heartbeatMs = integer(env, 'JOBS_HEARTBEAT_MS', 5_000, 100, 60_000);
  if (heartbeatMs >= leaseMs) throw new Error('JOBS_HEARTBEAT_MS must be lower than JOBS_LEASE_MS');
  return { enabled: env.JOBS_ENABLED !== 'false', workerId: `server-${randomUUID()}`,
    concurrency: integer(env, 'JOBS_CONCURRENCY', 2, 1, 16), scanIntervalMs: integer(env, 'JOBS_SCAN_MS', 1000, 100, 60_000),
    leaseMs, heartbeatMs, shutdownWaitMs: integer(env, 'JOBS_SHUTDOWN_WAIT_MS', 10_000, 1000, 60_000) };
}
