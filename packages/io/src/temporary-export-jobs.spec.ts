import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TemporaryExportJobs } from './temporary-export-jobs';
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
it('deduplicates active exports and removes the artifact after expiry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'framework-export-'));
  directories.push(directory);
  let complete!: (value: { buffer: Buffer; fileName: string; contentType: string }) => void;
  const jobs = new TemporaryExportJobs({
    directory,
    ttlMs: 60_000,
    cleanupIntervalMs: 20,
    deduplicationKey: (key: string) => key,
    build: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  try {
    const job = jobs.start('example');
    expect(jobs.start('example').id).toBe(job.id);
    // Rendering starts after the directory has been prepared.
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    complete({
      buffer: Buffer.from('synthetic'),
      fileName: 'example.txt',
      contentType: 'text/plain',
    });
    await vi.waitFor(() => expect(job.status).toBe('COMPLETED'));
    const { stream } = await jobs.download(job);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('synthetic');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    await vi.waitFor(() => expect(jobs.get(job.id)).toBeUndefined());
    expect(await readdir(directory)).toEqual([]);
  } finally {
    jobs.onModuleDestroy();
  }
});
