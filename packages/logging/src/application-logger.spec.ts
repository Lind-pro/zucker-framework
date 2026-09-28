// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@zucker-framework/core';
import { ApplicationLogger } from './application-logger';
import { DatabaseLogTransport } from './database-log-transport';
import { LogSanitizer } from './log-sanitizer';
import { WinstonLogSink } from './winston-log-sink';
describe('application system logging', () => {
  it('keeps independent injection contexts and redacts metadata before writing the shared sink', () => {
    const sink = { write: vi.fn() };
    const one = new ApplicationLogger(sink as unknown as WinstonLogSink, new LogSanitizer());
    const two = new ApplicationLogger(sink as unknown as WinstonLogSink, new LogSanitizer());
    one.setContext('First');
    two.setContext('Second');
    one.log('Started', { apiKey: 'private', port: 4100 });
    two.log('Mapped {/items, GET} route', 'HTTP');
    expect(sink.write.mock.calls[0]).toEqual([
      'info',
      'Started',
      { context: 'First', apiKey: '[REDACTED]', port: 4100 },
    ]);
    expect(sink.write.mock.calls[1][0]).toBe('debug');
  });
  it('awaits persistence and serializes cyclic metadata/bigints without recursive logging', async () => {
    let complete!: () => void;
    const create = vi.fn(
      (_input: { data: { metadata: Record<string, unknown> } }) =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const transport = new DatabaseLogTransport({
      database: { model: () => ({ create }) } as unknown as DatabaseAdapter,
    });
    const circular: Record<string, unknown> = { total: 5n, apiKey: 'private' };
    circular.self = circular;
    const callback = vi.fn();
    transport.log({ level: 'warn', message: 'Attention', context: 'Worker', circular }, callback);
    expect(callback).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.metadata.circular).toMatchObject({
      total: '5',
      apiKey: '[REDACTED]',
      self: '[CIRCULAR]',
    });
    complete();
    await new Promise((resolve) => setImmediate(resolve));
    expect(callback).toHaveBeenCalledOnce();
  });

  it('drains accepted logs once while preserving redacted diagnostics during and after shutdown', async () => {
    let complete!: () => void;
    const create = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const sanitizer = new LogSanitizer();
    const sink = new WinstonLogSink({
      level: 'debug',
      database: { adapter: { model: () => ({ create }) } as unknown as DatabaseAdapter },
    }, sanitizer);
    for (const transport of sink.logger.transports) {
      if (!(transport instanceof DatabaseLogTransport)) transport.silent = true;
    }
    const app = new ApplicationLogger(sink, sanitizer);
    const errors = vi.fn();
    sink.logger.on('error', errors);
    const end = vi.spyOn(sink.logger, 'end');
    const close = vi.spyOn(sink.logger, 'close');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      app.warn('Accepted before shutdown', { apiKey: 'before-secret' }, 'Worker');
      expect(create).toHaveBeenCalledOnce();
      const drained = vi.fn();
      const shutdown = sink.onModuleDestroy();
      void shutdown.then(drained);
      expect(sink.onModuleDestroy()).toBe(shutdown);
      const writes = vi.spyOn(sink.logger, 'log');

      app.error('Cleanup failed for worker@example.test', 'password=trace-secret', { token: 'late-secret' }, 'Shutdown');
      app.warn('Cleanup warning', 'Shutdown');
      app.log('Cleanup progress', 'Shutdown');
      app.debug('Cleanup debug', 'Shutdown');
      app.verbose('Cleanup detail', 'Shutdown');
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();

      complete();
      await shutdown;
      app.error('Cleanup after close', 'password=after-secret', 'Shutdown');
      await new Promise((resolve) => setImmediate(resolve));
      expect(end).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(errors).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('Cleanup failed');
      expect(output).toContain('Cleanup after close');
      expect(output).toContain('Shutdown');
      expect(output).toContain('[REDACTED]');
      for (const secret of ['worker@example.test', 'trace-secret', 'late-secret', 'after-secret']) {
        expect(output).not.toContain(secret);
      }
      expect(stderr).toHaveBeenCalledTimes(6);
    } finally {
      complete?.();
      await sink.onModuleDestroy();
      stderr.mockRestore();
    }
  });
});
